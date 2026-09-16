import express from "express";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { asyncHandler, notFound, HttpError } from "../lib/http.js";
import { parseByteRange } from "../lib/byteRange.js";
import { deriveOutcome } from "../lib/callOutcome.js";
import { requireAuth, requireCustomerAccount } from "../middleware/auth.js";
import { DEFAULT_AGENT_CONFIG, normalizeAutomations } from "../lib/agentConfig.js";
import { deliverCallToCrm } from "../services/webhook.js";
import { maybeCreateCalendarBooking, type BookingSignals, type Turn } from "../services/booking.js";
import { CALL_INTENTS, resolveIntent } from "../lib/callIntent.js";
import { CALLER_FALLBACK, callerLabel, realCallerName } from "../lib/callerName.js";
import {
  summarizeCallTranscript,
  classifyCallIntent,
  translateText,
  translateTranscript,
  normalizeTranscript,
  needsTranslation,
} from "../services/summary.js";
import { enforceTrialMinutes } from "../services/billing.js";
import { recordUsage, getPlanFeatures, getCallDurationCap } from "../services/trial.js";
import { scheduleWrapUp, cancelWrapUp } from "../services/callWrapUp.js";
import { settleAfterCall } from "../services/provisioning.js";
import { validateTrial } from "../middleware/trial.js";
import { getCallRecordingUrl, fetchVapiRecording } from "../services/vapi.js";
import { integrationsStatus, getEffective } from "../services/settings.js";
import { callSummaryEmail } from "../services/email.js";
import { isTwilioConfigured, callSummarySms } from "../services/sms.js";
import { isWhatsAppConfigured, callSummaryWhatsApp } from "../services/whatsapp.js";
import { env } from "../env.js";
import { notify } from "../services/notifications.js";
import { signRecording, verifyRecording } from "../lib/jwt.js";
import { turnsFromVapiMessages } from "../lib/vapiTranscript.js";
import { brandIdForOwner } from "../services/customerDirectory.js";
import { brandDisplayName, brandShareOrigin } from "../lib/brandUrls.js";
import { createCall, updateCall } from "../services/callWrite.js";
import { callDb, tenantForUser, requestTenant, allTenants } from "../services/tenantDb.js";
import { CallType, CallOutcome, type Prisma as TenantPrisma } from "@prisma/tenant-client";
import {
  vapiCallIdOf,
  hydrateCall,
  cacheArchivedTranslation,
} from "../services/callArchive.js";

/** Dashboard recording token TTL. Short is fine — a fresh one is minted every time the owner opens a call. */
const RECORDING_TOKEN_TTL_OWNER = "12h";
const RECORDING_TOKEN_TTL_SHARED = "30d";
/** Owner-copied share link TTL. 12h died before recipients opened it; kept well under 30d since it lands in inboxes we don't control. */
const RECORDING_TOKEN_TTL_SHARE = "7d";
/** Kept beside the constant so the UI can state the expiry without hardcoding it. */
const RECORDING_SHARE_DAYS = 7;

/** A short, unguessable slug for a call's public "More info" page. base64url of
 *  6 random bytes → 8 chars, keeping the summary-SMS link well within budget. */
function newPublicId(): string {
  return randomBytes(6).toString("base64url");
}

/** Public conversation page URL. Always the platform share host, never the brand domain (which serves only the SPA); the page still paints the brand's name. */
function conversationUrlFor(publicId: string): string {
  return `${brandShareOrigin()}/c/${publicId}`;
}

/** Recording proxy URL on our domain. The path is a SIGNED expiring token, not the (non-secret) id, so a leaked link dies.
 *  Falls back to the raw Vapi URL when no public base is configured. */
function proxiedRecordingUrl(
  callLogId: string,
  brandId: string,
  rawUrl?: string,
  ttl: string = RECORDING_TOKEN_TTL_SHARED,
): string | undefined {
  const base = (env.VAPI_SERVER_URL || env.PUBLIC_API_URL || "").replace(/\/$/, "");
  if (!base) return rawUrl;
  return `${base}/api/calls/recording-file/${signRecording(callLogId, brandId, ttl)}`;
}

/** The customer's brand, i.e. which DB their calls are in. Throws only for a pre-brand session token; a fresh sign-in fixes it. */
function brandOf(req: { user?: { brandId?: string | null } }): string {
  const brandId = req.user?.brandId;
  if (!brandId) throw new HttpError(401, "Please sign in again.", "session_stale");
  return brandId;
}

/** Audio extension from the upstream content-type, so a future format doesn't land as a `.wav` that isn't one. */
function audioExtFor(contentType: string): string {
  const t = contentType.toLowerCase();
  if (t.includes("mpeg") || t.includes("mp3")) return "mp3";
  if (t.includes("mp4") || t.includes("m4a") || t.includes("aac")) return "m4a";
  if (t.includes("ogg")) return "ogg";
  if (t.includes("webm")) return "webm";
  return "wav";
}

/** Download filename (without it the browser uses the JWT path segment). ASCII-only: quotes would end the header value, non-Latin turns to mojibake. */
function recordingFilename(callerName: string, createdAt: Date, contentType: string): string {
  const who = (callerName || "")
    .normalize("NFKD")
    .replace(/[^\x20-\x7E]/g, "") // drop non-ASCII rather than mangle it
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .toLowerCase();
  const stamp = createdAt.toISOString().slice(0, 16).replace("T", "-").replace(":", "");
  // Brand the file — an Acme customer shouldn't see the platform's name in their downloads.
  // Only up to the first dot: the fallback name is a domain, and "hello22-ai" reads like a typo.
  const label =
    brandDisplayName()
      .split(".")[0]
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "call";
  return [`${label}-call`, who, stamp].filter(Boolean).join("-") + `.${audioExtFor(contentType)}`;
}

/** Readable "Role: text" transcript. Vapi phone calls send a plain string; the
 *  web widget sends an array of turns — this flattens either into one blob. */
function transcriptToPlainText(raw: unknown): string {
  if (typeof raw === "string") return raw;
  if (!Array.isArray(raw)) return "";
  return (raw as any[])
    .map((t) => {
      const role = t?.role || t?.speaker || "";
      const text = t?.text || t?.message || t?.content || "";
      return role ? `${role}: ${text}` : String(text ?? "");
    })
    .join("\n");
}

/** Just the CALLER's words for the "did anyone speak?" check. With no recognisable roles, return everything rather than report silence. */
function callerTranscriptText(raw: unknown): string {
  const turns = normalizeTranscript(raw);
  const roleKnown = turns.some((t) => t.role === "caller" || t.role === "agent");
  const kept = roleKnown ? turns.filter((t) => t.role === "caller") : turns;
  return kept.map((t) => t.text).join(" ");
}

/** Did the AI book something? Appointment rows carry no call id, so match owner + time window (+60s tail).
 *  The ONLY source of a "booking" badge — deliberately narrow, a false positive is worse. Never throws. */
async function bookingConfirmedDuringCall(
  userId: string,
  callEndedAt: Date,
  durationSec: number,
): Promise<boolean> {
  const startedAt = new Date(callEndedAt.getTime() - Math.max(0, durationSec) * 1000 - 60_000);
  try {
    const count = await (await tenantForUser(userId)).appointment.count({
      where: {
        userId,
        source: "ai",
        status: "confirmed",
        createdAt: { gte: startedAt, lte: new Date(callEndedAt.getTime() + 60_000) },
      },
    });
    return count > 0;
  } catch {
    return false;
  }
}

const router = express.Router();

const MISSED_OUTCOMES: ReadonlySet<string> = new Set(["missed", "voicemail", "failed"]);

/** Turn a stored call into an in-app notification for its owner. Best-effort. */
function notifyOwnerOfCall(
  userId: string,
  call: {
    outcome: string;
    callerName?: string | null;
    callerNumber?: string | null;
    summary?: string | null;
    transferOutcome?: string | null;
    requestedDepartment?: string | null;
  },
  opts?: { test?: boolean },
): void {
  const who = realCallerName(call.callerName) || call.callerNumber?.trim() || CALLER_FALLBACK;

  // Web calls still get a record + notification (that's the rehearsal), labelled "Test call" so they're never mistaken for business.
  if (opts?.test) {
    void notify(userId, {
      type: "new_lead",
      title: "Test call recorded",
      message:
        call.summary?.trim() ||
        "Your test call is in the Call Inbox — open it to see the transcript and category.",
      link: "/dashboard/calls",
    });
    return;
  }

  // Highest priority: the caller asked for a human but the transfer didn't
  // connect. Surface their number + the department so the owner can call back.
  if (call.transferOutcome === "failed") {
    const dept = call.requestedDepartment?.trim();
    const number = call.callerNumber?.trim();
    const wanted = dept && dept.toLowerCase() !== "a person" ? `the ${dept} team` : "a person";
    void notify(userId, {
      type: "missed_call",
      title: "Transfer didn't connect — call back",
      message:
        `${who} wanted to speak with ${wanted} but the transfer couldn't connect.` +
        (number ? ` Call them back: ${number}.` : ""),
      link: "/dashboard/calls",
    });
    return;
  }

  const missed = MISSED_OUTCOMES.has(call.outcome);
  void notify(userId, {
    type: missed ? "missed_call" : "new_lead",
    title: missed ? "Missed call" : "New call handled",
    message: missed
      ? `You missed a call from ${who}.`
      : call.summary?.trim() || `Your AI receptionist handled a call from ${who}.`,
    link: "/dashboard/calls",
  });
}

/** Everything the owner's post-call summary needs, already localised. Channel-agnostic: built from both the Vapi report and a browser test call. */
interface OwnerSummaryCall {
  /** CallLog id — the recording proxy link is built from it. */
  id: string;
  /** Public "More info" slug, when the call has one. */
  publicId?: string | null;
  /** Friendly name for the notifications — already fallen back to something
   *  human-readable, never a placeholder like "Unknown". */
  callerName: string;
  callerNumber?: string;
  /** AI summary, already translated into the owner's report language. */
  summary?: string;
  /** Full "Role: text" transcript, already translated, for the email body. */
  transcript?: string;
  /** Recording URL we already know about, if any. */
  recordingUrl?: string;
  /** Vapi's call id. Lets us fetch a recording that finished processing after the
   *  call, and means the proxy can stream the audio even when no URL is stored. */
  vapiCallId?: string;
  /** Short "why they called" line for the SMS. */
  purpose?: string;
  durationSec?: number;
  /** Which DB the call is in; the recording link is signed with it. Required — an omitted brand would be silently wrong. */
  brandId: string | null;
  createdAt: Date;
}

/** Owner post-call summary on every enabled channel. Called from BOTH the Vapi webhook and POST / — web calls use an
 *  inline assistant so Vapi never fires a report for them. Each channel is fire-and-forget so none can break ingestion. */
function sendOwnerCallNotifications(
  userId: string,
  call: OwnerSummaryCall,
  automations: ReturnType<typeof normalizeAutomations>,
): void {
  const hasContent = Boolean(call.summary || call.transcript);

  // Best-effort owner email: AI summary + recording link + transcript.
  if (automations.ownerEmailSummary && integrationsStatus().email && (hasContent || call.recordingUrl)) {
    void (async () => {
      try {
        const owner = await (await tenantForUser(userId)).user.findUnique({
          where: { id: userId },
          select: { email: true },
        });
        // Summary override (if set) else the account's signup email.
        const emailTo = automations.summaryEmail?.trim() || owner?.email;
        if (!emailTo) return;
        // Recording is processed a few seconds post-call — fall back to
        // fetching it by call id if we weren't handed one.
        let recUrl = call.recordingUrl;
        if (!recUrl && call.vapiCallId) {
          recUrl = (await getCallRecordingUrl(call.vapiCallId)) ?? undefined;
        }
        // Persist any late-fetched recording so the proxy can serve it,
        // then email a link on OUR domain instead of storage.vapi.ai.
        if (recUrl && recUrl !== call.recordingUrl) {
          // Having createdAt to hand prunes the write to the call's own
          // monthly partition in the brand's database.
          await updateCall(
            call.brandId,
            { id: call.id, createdAt: call.createdAt },
            { recordingUrl: recUrl },
          );
        }
        // Link the recording whenever we can serve it — either a stored URL
        // (legacy) or a Vapi call id we can stream on demand via the proxy.
        const canServeRecording = Boolean(recUrl) || Boolean(call.vapiCallId);
        await callSummaryEmail({
          ownerEmail: emailTo,
          callerName: call.callerName,
          callerNumber: call.callerNumber,
          summary: call.summary,
          transcript: call.transcript || undefined,
          recordingUrl:
            canServeRecording && call.brandId
              ? proxiedRecordingUrl(call.id, call.brandId, recUrl)
              : undefined,
        });
      } catch {
        // Swallow — email is best-effort.
      }
    })();
  }

  // Owner SMS summary: needs the plan feature, an admin-set sender, and a mobile on file.
  if (
    automations.ownerSmsSummary &&
    isTwilioConfigured() &&
    getEffective("twilio.fromNumber").trim() &&
    hasContent
  ) {
    void (async () => {
      try {
        const features = await getPlanFeatures(userId);
        if (!features.sms) return;
        const owner = await (await tenantForUser(userId)).user.findUnique({
          where: { id: userId },
          select: { profile: { select: { mobile: true, businessName: true } } },
        });
        // Summary override (if set) else the account's mobile.
        const mobile = automations.summarySmsNumber?.trim() || owner?.profile?.mobile?.trim();
        if (!mobile) return;
        await callSummarySms({
          to: mobile,
          callerName: call.callerName,
          callerNumber: call.callerNumber,
          summary: call.summary,
          purpose: call.purpose || undefined,
          businessName: owner?.profile?.businessName || undefined,
          durationSec: call.durationSec,
          // Public "More info" link — only when the owner enabled it AND the
          // call actually has a public page.
          conversationUrl:
            automations.smsIncludeConversationLink && call.publicId
              ? conversationUrlFor(call.publicId)
              : undefined,
        });
      } catch {
        // Best-effort — SMS summary failures never break call ingestion.
      }
    })();
  }

  // Best-effort owner WhatsApp summary. Same gating pattern as SMS but
  // requires the owner's plan to include WhatsApp.
  if (automations.ownerWhatsAppSummary && isWhatsAppConfigured() && hasContent) {
    void (async () => {
      try {
        const features = await getPlanFeatures(userId);
        if (!features.whatsapp) return;
        const owner = await (await tenantForUser(userId)).user.findUnique({
          where: { id: userId },
          select: { profile: { select: { mobile: true, businessName: true } } },
        });
        // Summary override (if set) else the account's mobile.
        const mobile = automations.summaryWhatsAppNumber?.trim() || owner?.profile?.mobile?.trim();
        if (!mobile) return;
        await callSummaryWhatsApp({
          to: mobile,
          callerName: call.callerName,
          callerNumber: call.callerNumber,
          summary: call.summary,
          businessName: owner?.profile?.businessName || undefined,
          durationSec: call.durationSec,
          // Public "More info" link — only when the owner enabled it.
          conversationUrl:
            automations.whatsAppIncludeConversationLink && call.publicId
              ? conversationUrlFor(call.publicId)
              : undefined,
        });
      } catch {
        // Best-effort — WhatsApp summary failures never break call ingestion.
      }
    })();
  }
}

/** Translates the transcript into the owner's language and caches it on the call. Costs money, so callers gate on an email actually sending. */
async function localizeTranscriptForOwner(
  call: { id: string; createdAt: Date; brandId: string | null },
  transcript: unknown,
  transcriptText: string,
  language: string,
  summaryTranslated?: string,
): Promise<string> {
  const turns = normalizeTranscript(transcript);
  if (!turns.length) return transcriptText;
  const translated = await translateTranscript(
    turns.map((t) => ({ role: t.role, text: t.text })),
    language,
  );
  if (!translated) return transcriptText;
  const merged = translated.map((t, i) => ({ ...t, at: turns[i]?.at }));
  // Cached on the row (never archived — the call was logged seconds ago) with the language marker.
  await updateCall(
    call.brandId,
    { id: call.id, createdAt: call.createdAt },
    {
      transcriptTranslated: merged as TenantPrisma.InputJsonValue,
      summaryTranslated: summaryTranslated ?? null,
      transcriptTranslatedLang: language,
    },
  ).catch(() => {});
  return merged.map((t) => `${t.role === "agent" ? "Agent" : "Caller"}: ${t.text}`).join("\n");
}

/** The agent behind a Vapi assistant id — in whichever brand's database.
 *  A webhook carries no account, so every brand is asked in turn. */
async function conversionByAssistant(assistantId: string) {
  for (const { brandId, db } of await allTenants()) {
    const conversion = await db.conversion.findFirst({
      where: { vapiAssistantId: assistantId },
      select: { id: true, userId: true, agentConfig: true },
    });
    if (conversion) return { brandId, db, conversion };
  }
  return null;
}
/** Find the authenticated user's Conversion id, creating the Conversion if missing. */
async function getConversionId(userId: string): Promise<string> {
  const existing = await (await tenantForUser(userId)).conversion.findUnique({
    where: { userId },
    select: { id: true },
  });
  if (existing) return existing.id;
  const created = await (await tenantForUser(userId)).conversion.create({
    data: { userId, agentConfig: DEFAULT_AGENT_CONFIG as object },
    select: { id: true },
  });
  return created.id;
}

/** getConversionId plus the agent config. Separate so hot read paths don't drag the config JSON along. */
async function getConversionWithConfig(
  userId: string,
): Promise<{ id: string; agentConfig: TenantPrisma.JsonValue }> {
  const existing = await (await tenantForUser(userId)).conversion.findUnique({
    where: { userId },
    select: { id: true, agentConfig: true },
  });
  if (existing) return existing;
  return (await tenantForUser(userId)).conversion.create({
    data: { userId, agentConfig: DEFAULT_AGENT_CONFIG as object },
    select: { id: true, agentConfig: true },
  });
}

const listQuerySchema = z.object({
  search: z.string().optional(),
  outcome: z.nativeEnum(CallOutcome).optional(),
  type: z.nativeEnum(CallType).optional(),
  intent: z.enum(CALL_INTENTS).optional(),
  from: z.string().optional(),
  to: z.string().optional(),
  page: z.string().optional().default("1"),
  pageSize: z.string().optional().default("10"),
});

type ListQuery = z.infer<typeof listQuerySchema>;

/** Build a where clause, for the brand's own call table, scoped to the
 *  conversion plus the optional filters. */
function buildWhere(conversionId: string, q: ListQuery): TenantPrisma.CallLogWhereInput {
  const where: TenantPrisma.CallLogWhereInput = { conversionId };

  if (q.outcome) where.outcome = q.outcome;
  if (q.type) where.type = q.type;
  if (q.intent) where.intent = q.intent;

  if (q.from || q.to) {
    const createdAt: TenantPrisma.DateTimeFilter = {};
    if (q.from) createdAt.gte = new Date(q.from);
    if (q.to) createdAt.lte = new Date(q.to);
    where.createdAt = createdAt;
  }

  if (q.search && q.search.trim()) {
    where.OR = [
      { callerName: { contains: q.search, mode: "insensitive" } },
      { summary: { contains: q.search, mode: "insensitive" } },
    ];
  }

  return where;
}

router.get(
  "/",
  requireAuth,
  requireCustomerAccount,
  asyncHandler(async (req, res) => {
    const q = listQuerySchema.parse(req.query);
    const conversionId = await getConversionId(req.user!.sub);
    const where = buildWhere(conversionId, q);
    // The customer's calls are in their brand's own database — whole rows,
    // caller name and transcript included, so one read is the whole page.
    const db = await callDb(brandOf(req));

    const page = Math.max(1, Number(q.page) || 1);
    const pageSize = Math.min(Math.max(1, Number(q.pageSize) || 10), 500);

    const [rows, total] = await Promise.all([
      db.callLog.findMany({
        where,
        orderBy: { createdAt: "desc" },
        take: pageSize,
        skip: (page - 1) * pageSize,
      }),
      db.callLog.count({ where }),
    ]);

    // Archived rows are NOT rehydrated here (500 S3 round trips for a list page); they're flagged and
    // GET /:id hydrates the one that's opened. blobKey is a bucket path and stays server-side.
    const calls = rows.map(({ blobKey, blobArchivedAt, ...call }) => ({
      ...call,
      blobArchived: Boolean(blobKey),
    }));

    res.json({ calls, total });
  }),
);

router.get(
  "/stats",
  requireAuth,
  requireCustomerAccount,
  asyncHandler(async (req, res) => {
    const q = listQuerySchema.parse(req.query);
    const conversionId = await getConversionId(req.user!.sub);
    const where = buildWhere(conversionId, q);
    const db = await callDb(brandOf(req));

    // One grouped aggregate off the (conversionId, createdAt) index — this used to pull 50k rows into Node to render four numbers.
    const groups = await db.callLog.groupBy({
      by: ["outcome"],
      where,
      _count: { _all: true },
      _sum: { durationSec: true },
    });

    const completed = groups.find((g) => g.outcome === CallOutcome.completed);
    const completedCount = completed?._count._all ?? 0;
    const total = groups.reduce((sum, g) => sum + g._count._all, 0);
    const missed = groups.find((g) => g.outcome === CallOutcome.missed)?._count._all ?? 0;

    const successRate = total ? Math.round((completedCount / total) * 100) : 0;
    const missedRate = total ? Math.round((missed / total) * 100) : 0;
    const avgDurationSec = completedCount
      ? Math.round((completed?._sum.durationSec ?? 0) / completedCount)
      : 0;

    res.json({ total, successRate, avgDurationSec, missedRate });
  }),
);

/** Logs human-transfer events so a live transfer can be traced end to end. Best-effort, transfer-relevant events only. */
function logTransferAction(
  eventType: unknown,
  message: Record<string, any>,
  call: Record<string, any>,
): void {
  try {
    const type = String(eventType ?? "");
    // The destination/status fields Vapi attaches on transfer + status events.
    const destination = message.destination ?? message.transfer?.destination ?? null;
    const status = message.status ?? message.transferStatus ?? call.status;
    const endedReason = message.endedReason ?? call.endedReason;
    const isTransferEvent =
      /transfer/i.test(type) ||
      destination != null ||
      (type === "status-update" && /forward|transfer/i.test(String(status ?? "")));

    if (isTransferEvent) {
      console.log(
        `[transfer] call-action type=${type} status=${status ?? "-"} ` +
          `endedReason=${endedReason ?? "-"} ` +
          `dest=${destination ? JSON.stringify(destination).slice(0, 120) : "-"}`,
      );
    } else if (type === "end-of-call-report" && /transfer|forward/i.test(String(endedReason ?? ""))) {
      console.log(`[transfer] ended via transfer path — endedReason=${endedReason}`);
    }
  } catch {
    /* logging is best-effort — never block the webhook */
  }
}

/** Schedules the pre-cap wrap-up. The cap is recomputed (Vapi's payload doesn't carry maxDurationSeconds) with the same function that stamped the assistant, so they agree. */
async function maybeScheduleWrapUp(call: Record<string, any>, status: string): Promise<void> {
  // Vapi reports several statuses per call; only the transition to a live call
  // starts the clock we're racing.
  if (status !== "in-progress") return;
  const callId = typeof call.id === "string" ? call.id : "";
  const controlUrl = call.monitor?.controlUrl;
  if (!callId || typeof controlUrl !== "string") return;

  const assistantId = typeof call.assistantId === "string" ? call.assistantId : "";
  if (!assistantId) return;
  const conversion = (await conversionByAssistant(assistantId))?.conversion ?? null;
  if (!conversion) return;

  scheduleWrapUp({
    callId,
    controlUrl,
    capSeconds: await getCallDurationCap(conversion.userId),
    // Vapi timestamps the start; a webhook that arrived late must not push the
    // warning past the cut.
    startedAt: call.startedAt ? new Date(call.startedAt) : undefined,
  });
}

/** Vapi webhook auth via the x-vapi-secret header. A forged "call ended" POST could drain minutes or trigger a charge.
 *  Skipped only when no secret is configured (dev) — set VAPI_WEBHOOK_SECRET in every real environment or this stays open. */
function vapiWebhookAuthorized(req: express.Request): boolean {
  const secret = getEffective("vapi.webhookSecret").trim();
  if (!secret) return true; // not configured — nothing to verify against
  const provided = req.header("x-vapi-secret") ?? "";
  const a = Buffer.from(provided);
  const b = Buffer.from(secret);
  return a.length === b.length && timingSafeEqual(a, b);
}

router.post(
  "/webhook/vapi",
  asyncHandler(async (req, res) => {
    // Reject forged events before any side effect (usage, billing, wrap-up
    // control messages) can run.
    if (!vapiWebhookAuthorized(req)) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    try {
      const body = (req.body ?? {}) as Record<string, any>;
      const message = (body.message ?? {}) as Record<string, any>;
      const call = (message.call ?? {}) as Record<string, any>;

      // Only the final end-of-call report may create a call log, or one call becomes dozens of rows and minutes get counted repeatedly.
      const eventType = message.type ?? body.type;

      // Trace transfer actions so "it didn't ring first" reports can be checked against what Vapi did.
      logTransferAction(eventType, message, call);

      // Tell a capped call to wrap up a few seconds early so the caller hears a goodbye, not a dead line. Never affects the webhook result.
      if (eventType === "status-update") {
        try {
          await maybeScheduleWrapUp(call, String(message.status ?? ""));
        } catch (err) {
          console.error("[call-cap] could not schedule wrap-up:", err);
        }
      }

      if (eventType && eventType !== "end-of-call-report") {
        res.json({ received: true });
        return;
      }

      // Final report — whatever timer this call had is now moot.
      if (typeof call.id === "string") cancelWrapUp(call.id);

      const assistantId: unknown = call.assistantId ?? body.assistantId;

      if (typeof assistantId === "string" && assistantId) {
        const conversion = (await conversionByAssistant(assistantId))?.conversion ?? null;

        if (conversion) {
          // Notification prefs. summary* overrides redirect summaries only — login/OTP always use the default. Legacy configs default on.
          const automations = normalizeAutomations(
            (conversion.agentConfig as { automations?: unknown })?.automations,
          );
          const customer = (message.customer ?? body.customer ?? {}) as Record<string, any>;
          const analysis = (message.analysis ?? body.analysis ?? {}) as Record<string, any>;
          // Inbound calls carry no customer.name, so Vapi's structuredData is the primary source.
          const structured = (analysis.structuredData ?? {}) as Record<string, any>;
          const structuredName =
            typeof structured.name === "string" ? structured.name.trim() : "";
          const structuredPhone =
            typeof structured.phone === "string" ? structured.phone.trim() : "";
          // Short "why they called" line for the summary SMS (see analysisPlan in
          // services/vapi.ts). Falls back to the AI summary when Vapi didn't set it.
          const structuredPurpose =
            typeof structured.purpose === "string" ? structured.purpose.trim() : "";
          // Which department/team the caller asked to be connected to (extracted
          // by the assistant when transfer is enabled).
          const requestedDepartment =
            typeof structured.requestedDepartment === "string"
              ? structured.requestedDepartment.trim()
              : "";

          // Placeholders ("unknown", "n/a") aren't names — storing them puts "Unknown" in front of the owner everywhere.
          const callerName =
            realCallerName(structuredName) ??
            realCallerName(typeof customer.name === "string" ? customer.name : "");
          const callerNumber =
            (typeof customer.number === "string" && customer.number.trim()
              ? customer.number
              : undefined) ?? (structuredPhone || undefined);
          // Friendly name for owner notifications (email/SMS/WhatsApp).
          const callerDisplayName = callerName ?? "A caller";
          const durationRaw = message.durationSeconds ?? body.durationSec ?? body.durationSeconds;
          const durationSec =
            typeof durationRaw === "number" ? Math.round(durationRaw) : undefined;
          const endedReason = message.endedReason ?? call.endedReason ?? body.endedReason;
          const outcome = deriveOutcome(endedReason, durationSec);
          // Bridged calls end with a "*-forwarded-*" reason. Asked for a human but not forwarded = failed transfer, flag for callback.
          const transferForwarded = /forward/i.test(String(endedReason ?? ""));
          const wantedTransfer = requestedDepartment.length > 0 || transferForwarded;
          const transferOutcome = wantedTransfer
            ? transferForwarded
              ? "connected"
              : "failed"
            : "";
          const summary =
            (typeof analysis.summary === "string" && analysis.summary) ||
            (typeof body.summary === "string" && body.summary) ||
            undefined;
          // Stored summary stays in the call's language (source of truth); the owner's copy is translated best-effort.
          let summaryForOwner = summary;
          if (summary && needsTranslation(automations.reportLanguage)) {
            const localized = await translateText(summary, automations.reportLanguage);
            if (localized) summaryForOwner = localized;
          }
          const analysisJson =
            message.analysis ?? body.analysis ?? undefined;
          const artifact = (message.artifact ?? body.artifact ?? {}) as Record<string, any>;
          // Prefer structured messages (per-turn timing); fall back to the plain string transcript.
          const transcript =
            turnsFromVapiMessages(
              artifact.messages ?? message.messages ?? body.messages,
            ) ??
            message.transcript ??
            body.transcript;
          const recordingUrl =
            (typeof message.recordingUrl === "string" && message.recordingUrl) ||
            (typeof artifact.recordingUrl === "string" && artifact.recordingUrl) ||
            (typeof body.recordingUrl === "string" && body.recordingUrl) ||
            undefined;
          // Vapi call id, needed for the authenticated recording download. Own column so playback survives
          // the analysis blob being archived to S3; mirrored into `analysis` for old readers.
          const vapiCallId =
            (typeof call.id === "string" && call.id) ||
            (typeof body.callId === "string" && body.callId) ||
            undefined;

          // Intent from structuredData (free), keyword heuristic as fallback. The lead rule reads `structured`, not
          // customer.number — inbound calls always have caller ID, so only spoken details count as captured.
          const intent = resolveIntent({
            bookingConfirmed: await bookingConfirmedDuringCall(
              conversion.userId,
              new Date(),
              durationSec ?? 0,
            ),
            structuredIntent: structured.intent,
            structured,
            purpose: structuredPurpose,
            summary,
            transcript: transcriptToPlainText(transcript),
            callerText: callerTranscriptText(transcript),
          });

          // Public conversation page: unguessable slug, 0 validity hours = never expires. Generated for every call; SMS includes it only if toggled on.
          const validityHours = automations.conversationLinkValidityHours;
          const publicId = newPublicId();
          const shareExpiresAt =
            validityHours > 0 ? new Date(Date.now() + validityHours * 3_600_000) : null;

          // Resolved first: it decides which DB the transcript may be written to.
          const callBrandId = await brandIdForOwner(conversion.userId);
          const callLog = await createCall(callBrandId, {
            conversionId: conversion.id,
            type: CallType.Phone,
            outcome,
            publicId,
            shareExpiresAt,
            ...(structuredPurpose ? { purpose: structuredPurpose } : {}),
            ...(intent ? { intent } : {}),
            ...(requestedDepartment ? { requestedDepartment } : {}),
            ...(transferOutcome ? { transferOutcome } : {}),
            ...(callerName !== undefined ? { callerName } : {}),
            ...(callerNumber !== undefined ? { callerNumber } : {}),
            ...(durationSec !== undefined ? { durationSec } : {}),
            ...(summary !== undefined ? { summary } : {}),
            ...(recordingUrl !== undefined ? { recordingUrl } : {}),
            ...(transcript !== undefined ? { transcript: transcript as TenantPrisma.InputJsonValue } : {}),
            // Own column: `analysis` is archivable, and a recording only reachable through it would stop playing.
            ...(vapiCallId ? { vapiCallId } : {}),
            // Also folded into the analysis JSON so the stored shape stays identical for old readers.
            ...(analysisJson !== undefined || vapiCallId
              ? {
                  analysis: {
                    ...(analysisJson && typeof analysisJson === "object" ? analysisJson : {}),
                    ...(vapiCallId ? { vapiCallId } : {}),
                  } as TenantPrisma.InputJsonValue,
                }
              : {}),
          });

          // Junk is logged but never pushed as business (no notification, no CRM). "" = caller never spoke: no
          // CRM lead either, but the owner is still notified — they have the number and may want to ring back.
          const isJunk = intent === "spam";
          const nothingToFile = isJunk || intent === "";
          if (!isJunk) notifyOwnerOfCall(conversion.userId, callLog);
          if (!nothingToFile) {
            // Best-effort CRM lead delivery (fire-and-forget)
            void deliverCallToCrm(conversion.userId, callLog, { brandId: callBrandId });
          } else {
            console.log(
              `[intent] call ${callLog.id} (${intent || "silent"}) — CRM push suppressed`,
            );
          }
          // Post-call Calendar booking, fire-and-forget. Transcript is the LLM fallback when structuredData is absent.
          void maybeCreateCalendarBooking(conversion.userId, structured as BookingSignals, {
            transcript: Array.isArray(transcript)
              ? (transcript as { role?: unknown; text?: unknown }[])
                  .map((t) => ({ role: String(t?.role ?? ""), text: String(t?.text ?? "") }))
                  .filter((t) => t.text)
              : [],
          }).then((r) =>
            console.log(
              r.ok
                ? `[booking] created event ${r.id ?? ""} for user ${conversion.userId}`
                : `[booking] skipped (${r.skipped}) for user ${conversion.userId}`,
            ),
          );
          // Track trial usage + recompute status, then enforce the Stripe-billed
          // trial (legacy card-on-file path). Both are best-effort.
          if (durationSec !== undefined) {
            // Record usage, then settle (auto-charge if the trial just ended, re-sync the cap). Order matters; all best-effort.
            void recordUsage(conversion.userId, durationSec).then(() =>
              settleAfterCall(conversion.userId),
            );
          }
          void enforceTrialMinutes(conversion.userId);

          // Readable transcript text (Vapi sends a string; handle arrays too).
          const transcriptText = transcriptToPlainText(transcript);

          // Translate + cache the transcript for the owner's email, only when an email will actually send.
          let ownerTranscriptText = transcriptText;
          if (
            transcriptText &&
            needsTranslation(automations.reportLanguage) &&
            automations.ownerEmailSummary &&
            integrationsStatus().email
          ) {
            ownerTranscriptText = await localizeTranscriptForOwner(
              { id: callLog.id, createdAt: callLog.createdAt, brandId: callBrandId },
              transcript,
              transcriptText,
              automations.reportLanguage,
              summaryForOwner,
            );
          }

          // Owner's post-call summary on every channel they've enabled. Shared
          // with the web-call path below so both produce the same notifications.
          sendOwnerCallNotifications(
            conversion.userId,
            {
              id: callLog.id,
              // Carried so a late-arriving recording URL is written to the
              // brand's own database rather than this one.
              brandId: callBrandId,
              createdAt: callLog.createdAt,
              publicId,
              callerName: callerDisplayName,
              callerNumber,
              summary: summaryForOwner,
              transcript: ownerTranscriptText,
              recordingUrl,
              vapiCallId,
              purpose: structuredPurpose,
              durationSec,
            },
            automations,
          );
        }
      }
    } catch {
      // Best-effort ingestion: never throw on a webhook.
    }
    res.json({ received: true });
  }),
);

const createSchema = z.object({
  type: z.nativeEnum(CallType).optional(),
  callerName: z.string().optional(),
  callerNumber: z.string().optional(),
  durationSec: z.number().int().optional(),
  outcome: z.nativeEnum(CallOutcome).optional(),
  summary: z.string().optional(),
  recordingUrl: z.string().optional(),
  transcript: z.any().optional(),
  analysis: z.any().optional(),
});

router.post(
  "/",
  requireAuth,
  requireCustomerAccount,
  validateTrial,
  asyncHandler(async (req, res) => {
    const body = createSchema.parse(req.body);
    const { id: conversionId, agentConfig } = await getConversionWithConfig(req.user!.sub);
    // Owner notification preferences — the same toggles the phone path reads.
    const automations = normalizeAutomations(
      (agentConfig as { automations?: unknown })?.automations,
    );

    // Classify test calls like real ones. No Vapi structuredData here, so ask the LLM (cheap, few calls) with the keyword heuristic as fallback.
    const transcriptText = transcriptToPlainText(body.transcript);
    const bodyStructured = ((body.analysis as { structuredData?: unknown } | undefined)
      ?.structuredData ?? {}) as Record<string, unknown>;
    // Without this read the lead rule could never fire on a test call. One request answers intent and contact-captured.
    const llmRead = await classifyCallIntent(normalizeTranscript(body.transcript)).catch(() => ({
      category: "",
      contactCaptured: false,
    }));
    const intent = resolveIntent({
      bookingConfirmed: await bookingConfirmedDuringCall(
        req.user!.sub,
        new Date(),
        body.durationSec ?? 0,
      ),
      structuredIntent: bodyStructured.intent,
      llmIntent: llmRead.category,
      structured: bodyStructured,
      contactCaptured: llmRead.contactCaptured,
      purpose: typeof bodyStructured.purpose === "string" ? bodyStructured.purpose : "",
      summary: body.summary,
      transcript: transcriptText,
      callerText: callerTranscriptText(body.transcript),
    });

    // Conversation page, same as a phone call — the summary SMS "More info" link needs it. 0 validity hours = never expires.
    const validityHours = automations.conversationLinkValidityHours;
    const publicId = newPublicId();
    const shareExpiresAt =
      validityHours > 0 ? new Date(Date.now() + validityHours * 3_600_000) : null;

    // Own column: `analysis` is archivable, and a recording only reachable through it would stop playing.
    const vapiCallId =
      typeof (body.analysis as { vapiCallId?: unknown } | undefined)?.vapiCallId === "string"
        ? (body.analysis as { vapiCallId: string }).vapiCallId
        : undefined;

    // Same reason as the webhook path: which brand this belongs to decides
    // which database its transcript may be written to.
    const callBrandId = await brandIdForOwner(req.user!.sub);
    const call = await createCall(callBrandId, {
      conversionId,
      publicId,
      shareExpiresAt,
      ...(vapiCallId ? { vapiCallId } : {}),
      ...(intent ? { intent } : {}),
      ...(body.type !== undefined ? { type: body.type } : {}),
      ...(body.callerName !== undefined ? { callerName: body.callerName } : {}),
      ...(body.callerNumber !== undefined ? { callerNumber: body.callerNumber } : {}),
      ...(body.durationSec !== undefined ? { durationSec: body.durationSec } : {}),
      ...(body.outcome !== undefined ? { outcome: body.outcome } : {}),
      ...(body.summary !== undefined ? { summary: body.summary } : {}),
      ...(body.recordingUrl !== undefined ? { recordingUrl: body.recordingUrl } : {}),
      ...(body.transcript !== undefined
        ? { transcript: body.transcript as TenantPrisma.InputJsonValue }
        : {}),
      ...(body.analysis !== undefined
        ? { analysis: body.analysis as TenantPrisma.InputJsonValue }
        : {}),
    });

    // Web calls run the SAME lead pipeline as real calls, only labelled ("Test call", "[TEST]" CRM prefix).
    // Junk never propagates, test or not.
    const isTestCall = call.type === CallType.Web;
    if (intent !== "spam") notifyOwnerOfCall(req.user!.sub, call, { test: isTestCall });
    if (intent !== "spam" && intent !== "") {
      void deliverCallToCrm(req.user!.sub, call, { test: isTestCall, brandId: callBrandId });
    } else {
      console.log(`[intent] call ${call.id} (${intent || "silent"}) — CRM push suppressed`);
    }

    // Summary must be sent from HERE: a browser call uses an inline assistant, so Vapi never fires a report.
    // Stored summary stays in the call's language; the owner's copy is translated best-effort.
    let summaryForOwner = body.summary;
    if (body.summary && needsTranslation(automations.reportLanguage)) {
      const localized = await translateText(body.summary, automations.reportLanguage);
      if (localized) summaryForOwner = localized;
    }
    // Translate + cache the transcript too, only when an email will actually send.
    let ownerTranscriptText = transcriptText;
    if (
      transcriptText &&
      needsTranslation(automations.reportLanguage) &&
      automations.ownerEmailSummary &&
      integrationsStatus().email
    ) {
      ownerTranscriptText = await localizeTranscriptForOwner(
        { id: call.id, createdAt: call.createdAt, brandId: callBrandId },
        body.transcript,
        transcriptText,
        automations.reportLanguage,
        summaryForOwner,
      );
    }
    sendOwnerCallNotifications(
      req.user!.sub,
      {
        id: call.id,
        brandId: callBrandId,
        createdAt: call.createdAt,
        publicId,
        callerName: callerLabel(call.callerName),
        callerNumber: call.callerNumber || undefined,
        summary: summaryForOwner,
        transcript: ownerTranscriptText,
        recordingUrl: body.recordingUrl,
        vapiCallId,
        purpose: typeof bodyStructured.purpose === "string" ? bodyStructured.purpose : undefined,
        durationSec: body.durationSec,
      },
      automations,
    );

    // Booking works on test calls too. No structuredData on web calls, so the transcript is the LLM fallback.
    const structured = ((body.analysis as { structuredData?: unknown } | undefined)
      ?.structuredData ?? {}) as BookingSignals;
    const transcriptTurns: Turn[] = Array.isArray(body.transcript)
      ? (body.transcript as { role?: unknown; text?: unknown }[])
          .map((t) => ({ role: String(t?.role ?? ""), text: String(t?.text ?? "") }))
          .filter((t) => t.text)
      : [];
    void maybeCreateCalendarBooking(req.user!.sub, structured, { transcript: transcriptTurns }).then(
      (r) => {
        if (r.ok) console.log(`[booking] created event ${r.id ?? ""} for user ${req.user!.sub}`);
        else console.log(`[booking] skipped (${r.skipped}) for user ${req.user!.sub}`);
      },
    );

    // Web-call minutes count against the trial/plan like real ones. settleAfterCall may auto-charge and re-sync the cap;
    // legacy Stripe enforcement stays as a fallback (no-op once converted).
    if (body.durationSec !== undefined) {
      await recordUsage(req.user!.sub, body.durationSec);
      await settleAfterCall(req.user!.sub);
    }
    await enforceTrialMinutes(req.user!.sub);

    res.json(call);
  }),
);

const summarizeSchema = z.object({
  transcript: z
    .array(z.object({ role: z.string(), text: z.string(), at: z.number().optional() }))
    .default([]),
});

router.post(
  "/summarize",
  requireAuth,
  requireCustomerAccount,
  asyncHandler(async (req, res) => {
    const { transcript } = summarizeSchema.parse(req.body);
    const summary = await summarizeCallTranscript(transcript);
    res.json({ summary });
  }),
);

/** Lazily translates a transcript into the owner's report language and caches it. Falls back to the original. Returns `{ lang, transcript }`. */
router.post(
  "/:id/translate",
  requireAuth,
  requireCustomerAccount,
  asyncHandler(async (req, res) => {
    const conversion = await (await requestTenant(req)).conversion.findUnique({
      where: { userId: req.user!.sub },
      select: { id: true, agentConfig: true },
    });
    if (!conversion) throw notFound("Call not found");
    const automations = normalizeAutomations(
      (conversion.agentConfig as { automations?: unknown })?.automations,
    );
    const lang = automations.reportLanguage;

    const db = await callDb(brandOf(req));
    const found = await db.callLog.findFirst({
      where: { id: req.params.id, conversionId: conversion.id },
      select: {
        id: true,
        summary: true,
        transcript: true,
        transcriptTranslated: true,
        transcriptTranslatedLang: true,
        summaryTranslated: true,
        blobKey: true,
        // Half of the primary key on a partitioned table — carried so the cache
        // write below prunes to one month instead of probing every partition.
        createdAt: true,
      },
    });
    if (!found) throw notFound("Call not found");
    // Hydrate first, or an archived call would translate an empty transcript and cache it.
    const call = await hydrateCall(found);

    // No report language → nothing to translate; return the originals as-is.
    if (!needsTranslation(lang)) {
      res.json({ lang: "", transcript: call.transcript, summary: call.summary });
      return;
    }

    // Cache hit — both were already translated into this language. Zero LLM calls.
    if (call.transcriptTranslatedLang === lang && call.transcriptTranslated) {
      res.json({
        lang,
        transcript: call.transcriptTranslated,
        summary: call.summaryTranslated ?? call.summary,
      });
      return;
    }

    // Cache miss (first view / language changed) — translate summary + transcript
    // once, store both under the shared language marker, then serve from cache next time.
    const summaryOut = call.summary
      ? (await translateText(call.summary, lang)) || call.summary
      : call.summary;

    const turns = normalizeTranscript(call.transcript);
    const translated = await translateTranscript(
      turns.map((t) => ({ role: t.role, text: t.text })),
      lang,
    );
    // Re-attach the original per-turn timestamps for the player's role bubbles.
    const transcriptOut = translated
      ? translated.map((t, i) => ({ ...t, at: turns[i]?.at }))
      : call.transcript;

    // Only persist the cache when the transcript actually translated (so a transient
    // failure doesn't lock in a bad marker); the summary rides along with it.
    if (translated) {
      // Archived: the S3 object is the source of truth, so cache there — on the column it'd be masked by the next
      // hydrate and every view would re-bill the translation. The scalar markers stay on the row either way.
      if (call.blobKey) await cacheArchivedTranslation(call.blobKey, transcriptOut);
      const key = { id: call.id, createdAt: call.createdAt };
      // Translations are personal data and follow the originals: archived blob, else the brand DB, else here.
      await db.callLog.update({
        where: { id_createdAt: key },
        data: {
          transcriptTranslatedLang: lang,
          ...(call.blobKey
            ? {}
            : {
                transcriptTranslated: transcriptOut as TenantPrisma.InputJsonValue,
                summaryTranslated: summaryOut ?? null,
              }),
        },
      });
    }

    res.json({ lang, transcript: transcriptOut, summary: summaryOut });
  }),
);

const patchSchema = z.object({
  recordingUrl: z.string().optional(),
  // Web calls save immediately on hang-up (so a page refresh can't lose the call
  // or its minutes), then enrich the AI summary a moment later via this PATCH.
  summary: z.string().optional(),
  analysis: z.any().optional(),
});

/** Attach late-arriving data (e.g. a recording processed after the call, or the
 *  AI summary computed just after a web call was saved). */
router.patch(
  "/:id",
  requireAuth,
  requireCustomerAccount,
  asyncHandler(async (req, res) => {
    const { recordingUrl, summary, analysis } = patchSchema.parse(req.body);
    const conversionId = await getConversionId(req.user!.sub);
    const brandId = brandOf(req);
    const db = await callDb(brandId);
    // The ownership read also returns createdAt (other half of the partitioned key) so the update hits one partition.
    const existing = await db.callLog.findFirst({
      where: { id: req.params.id, conversionId },
      select: { id: true, createdAt: true },
    });
    if (!existing) throw notFound("Call not found");
    const key = { id: existing.id, createdAt: existing.createdAt };
    const call = await updateCall(brandId, key, {
      ...(recordingUrl !== undefined ? { recordingUrl } : {}),
      ...(summary !== undefined ? { summary } : {}),
      ...(analysis !== undefined ? { analysis: analysis as TenantPrisma.InputJsonValue } : {}),
    });
    res.json(call);
  }),
);

/** Owner correction of a call's category. Stamps intentSource="user" so no later AI pass can undo it. */
const intentSchema = z.object({ intent: z.enum(CALL_INTENTS) });

router.patch(
  "/:id/intent",
  requireAuth,
  requireCustomerAccount,
  asyncHandler(async (req, res) => {
    const { intent } = intentSchema.parse(req.body);
    const conversionId = await getConversionId(req.user!.sub);
    const db = await callDb(brandOf(req));
    const existing = await db.callLog.findFirst({
      where: { id: req.params.id, conversionId },
      select: { id: true, createdAt: true },
    });
    if (!existing) throw notFound("Call not found");
    const call = await db.callLog.update({
      where: { id_createdAt: { id: existing.id, createdAt: existing.createdAt } },
      data: { intent, intentSource: "user" },
    });
    res.json(call);
  }),
);

router.get(
  "/recording",
  requireAuth,
  requireCustomerAccount,
  asyncHandler(async (req, res) => {
    const { vapiCallId } = req.query;
    if (!vapiCallId) {
      res.json({ recordingUrl: null });
      return;
    }
    const recordingUrl = await getCallRecordingUrl(String(vapiCallId));
    res.json({ recordingUrl });
  }),
);

/** Owner playback URL. <audio> can't send a bearer token, so this authed, own-calls-only route mints a freshly signed proxy URL. { url: null } when nothing to stream. */
router.get(
  "/:id/recording-url",
  requireAuth,
  requireCustomerAccount,
  asyncHandler(async (req, res) => {
    const conversionId = await getConversionId(req.user!.sub);
    const brandId = brandOf(req);
    const db = await callDb(brandId);
    const call = await db.callLog.findFirst({
      where: { id: req.params.id, conversionId },
      select: { id: true, recordingUrl: true, vapiCallId: true, analysis: true },
    });
    if (!call) throw notFound("Call not found");
    const vapiCallId = vapiCallIdOf(call);
    const canServe = Boolean(call.recordingUrl) || Boolean(vapiCallId);
    // `?share=1` is a link the owner is sending to someone, so it outlives the re-minted player token.
    const share = req.query.share === "1";
    res.json({
      url: canServe
        ? proxiedRecordingUrl(
            call.id,
            brandId,
            call.recordingUrl ?? undefined,
            share ? RECORDING_TOKEN_TTL_SHARE : RECORDING_TOKEN_TTL_OWNER,
          )
        : null,
      ...(share ? { expiresInDays: RECORDING_SHARE_DAYS } : {}),
    });
  }),
);

/** Public recording proxy, no login (<audio> and email links can't send a bearer). Gated by a SIGNED expiring token in the
 *  path — the call-log id was never a secret. Pulls from Vapi's authenticated endpoint (storage URLs stopped being public in
 *  2026), legacy stored URL as fallback. Byte ranges honoured, else the browser treats the source as unseekable. */
router.get(
  "/recording-file/:token",
  asyncHandler(async (req, res) => {
    // Bad/expired token is a 404, same as unknown — a probe learns nothing about which recordings exist.
    let claim: { callLogId: string; brandId: string };
    try {
      claim = verifyRecording(req.params.token);
    } catch {
      throw notFound("Recording not found");
    }
    // The token names the brand (this route serves every brand from the platform host). findFirst because the
    // id is half a partitioned primary key; still at most one row.
    const db = await callDb(claim.brandId).catch(() => null);
    const call = db
      ? await db.callLog.findFirst({
          where: { id: claim.callLogId },
          select: {
            id: true,
            createdAt: true,
            recordingUrl: true,
            vapiCallId: true,
            analysis: true,
            callerName: true,
          },
        })
      : null;
    if (!call) throw notFound("Recording not found");

    const vapiCallId = vapiCallIdOf(call);
    const rangeHeader = typeof req.headers.range === "string" ? req.headers.range : undefined;

    /** Vapi's authenticated download first; rows without a call id fall back to the saved URL with our API key attached. */
    const fetchUpstream = async (withRange: boolean): Promise<Response | null> => {
      const extra = withRange && rangeHeader ? { Range: rangeHeader } : undefined;
      let res: Response | null =
        vapiCallId
          ? await fetchVapiRecording(vapiCallId, "mono", extra)
          : null;
      if ((!res || !res.ok) && call.recordingUrl) {
        res = await fetch(call.recordingUrl, {
          headers: { Authorization: `Bearer ${getEffective("vapi.apiKey")}`, ...extra },
        }).catch(() => null);
      }
      return res;
    };

    let upstream = await fetchUpstream(true);

    // Some sources 400/416 a ranged request. Retry plain; the range is then satisfied by slicing the body ourselves.
    if (rangeHeader && (!upstream || !upstream.ok)) upstream = await fetchUpstream(false);

    if (!upstream || !upstream.ok || !upstream.body) throw notFound("Recording not available");

    const contentType = upstream.headers.get("content-type") || "audio/wav";
    res.setHeader("Content-Type", contentType);
    // The player MUST stay `inline` — `attachment` makes the browser download instead of stream, breaking seeking.
    res.setHeader(
      "Content-Disposition",
      req.query.download === "1"
        ? `attachment; filename="${recordingFilename(call.callerName, call.createdAt, contentType)}"`
        : "inline",
    );
    res.setHeader("Accept-Ranges", "bytes");

    // A HEAD probe (some players make one first) only wants the headers.
    const sendBody = (body: Buffer) => {
      res.setHeader("Content-Length", String(body.length));
      if (req.method === "HEAD") res.end();
      else res.end(body);
    };

    // Upstream honoured the range — hand its slice straight to the client. (Only
    // when the client actually asked for one; an unsolicited 206 would confuse it.)
    if (rangeHeader && upstream.status === 206) {
      const contentRange = upstream.headers.get("content-range");
      if (contentRange) res.setHeader("Content-Range", contentRange);
      res.status(206);
      sendBody(Buffer.from(await upstream.arrayBuffer()));
      return;
    }

    const full = Buffer.from(await upstream.arrayBuffer());

    // No range asked for (email link, download, first load) — unchanged behaviour.
    if (!rangeHeader) {
      sendBody(full);
      return;
    }

    // Upstream ignored the range, so satisfy it here.
    const parsed = parseByteRange(rangeHeader, full.length);
    if (parsed === "unsatisfiable") {
      res.setHeader("Content-Range", `bytes */${full.length}`);
      res.status(416).end();
      return;
    }
    if (!parsed) {
      sendBody(full);
      return;
    }
    res.status(206);
    res.setHeader("Content-Range", `bytes ${parsed.start}-${parsed.end}/${full.length}`);
    sendBody(full.subarray(parsed.start, parsed.end + 1));
  }),
);

router.get(
  "/:id",
  requireAuth,
  requireCustomerAccount,
  asyncHandler(async (req, res) => {
    const conversionId = await getConversionId(req.user!.sub);
    const db = await callDb(brandOf(req));
    const call = await db.callLog.findFirst({
      where: { id: req.params.id, conversionId },
    });
    if (!call) throw notFound("Call not found");
    // The one path that must carry the full transcript, so an archived call costs one S3 GET here. Bucket key stays server-side.
    const { blobKey, blobArchivedAt, ...hydrated } = await hydrateCall(call);
    res.json({ ...hydrated, blobArchived: false });
  }),
);

export default router;
