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

/** How long a recording link stays playable. Short for the owner's dashboard —
 *  a fresh token is minted every time they open a call, so it never actually
 *  expires for them — and a bounded window for links that leave our control
 *  (emailed summaries, CRM leads, the public conversation page). */
const RECORDING_TOKEN_TTL_OWNER = "12h";
const RECORDING_TOKEN_TTL_SHARED = "30d";
/** A link the owner deliberately copied to send to someone. Longer than the
 *  dashboard's own token — 12h died before the recipient got round to it — but
 *  well short of the 30d we give machine-generated summary links, because this
 *  one is pasted into chats and inboxes we don't control. */
const RECORDING_TOKEN_TTL_SHARE = "7d";
/** Kept beside the constant so the UI can state the expiry without hardcoding it. */
const RECORDING_SHARE_DAYS = 7;

/** A short, unguessable slug for a call's public "More info" page. base64url of
 *  6 random bytes → 8 chars, keeping the summary-SMS link well within budget. */
function newPublicId(): string {
  return randomBytes(6).toString("base64url");
}

/**
 * Public URL of a call's conversation page, linked from the summary SMS.
 *
 * Always on the platform's share host (SHARE_LINK_BASE_URL), never the brand's
 * domain: a brand's domain serves only the SPA, while the API and everything
 * call-related — this page, the webhooks, the recording proxy — stay on the
 * platform's host for every tenant. The page still paints the owning brand's
 * name (see routes/publicCall.routes.ts).
 */
function conversationUrlFor(publicId: string): string {
  return `${brandShareOrigin()}/c/${publicId}`;
}

/** Public URL of our recording proxy for a call log, so links carry our own
 *  domain instead of exposing storage.vapi.ai. The path segment is a SIGNED,
 *  expiring token wrapping the call-log id — not the id itself — so a leaked
 *  link can't be replayed forever and the (non-secret) id grants nothing on its
 *  own. Falls back to the raw Vapi URL when no public base is configured.
 *  `ttl` defaults to the shared-link window; the owner dashboard passes a short one. */
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

/**
 * The signed-in customer's brand — which is to say, which database their calls
 * are in. Every route below sits behind requireCustomerAccount, and a customer
 * always belongs to a brand; the throw is for a session minted before tokens
 * carried one, which a fresh sign-in fixes.
 */
function brandOf(req: { user?: { brandId?: string | null } }): string {
  const brandId = req.user?.brandId;
  if (!brandId) throw new HttpError(401, "Please sign in again.", "session_stale");
  return brandId;
}

/** Extension for the audio we're proxying. Vapi serves WAV today; read it from
 *  the upstream content-type so a future format lands with the right suffix
 *  instead of a file named `.wav` that isn't one. */
function audioExtFor(contentType: string): string {
  const t = contentType.toLowerCase();
  if (t.includes("mpeg") || t.includes("mp3")) return "mp3";
  if (t.includes("mp4") || t.includes("m4a") || t.includes("aac")) return "m4a";
  if (t.includes("ogg")) return "ogg";
  if (t.includes("webm")) return "webm";
  return "wav";
}

/**
 * The filename a downloaded recording lands on disk with.
 *
 * Without this the browser names the file after the URL's last segment — which
 * is the signed JWT — so downloads arrived as an unreadable 200-character blob
 * with no extension, and you couldn't tell what kind of file it even was.
 *
 * Reduced to ASCII letters, digits and dashes: a caller name can contain quotes
 * (which would terminate the header value), slashes, or a non-Latin script that
 * turns into mojibake in a bare `filename=`. A name that survives none of that
 * simply drops out, leaving the date to identify the call.
 */
function recordingFilename(callerName: string, createdAt: Date, contentType: string): string {
  const who = (callerName || "")
    .normalize("NFKD")
    .replace(/[^\x20-\x7E]/g, "") // drop non-ASCII rather than mangle it
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .toLowerCase();
  const stamp = createdAt.toISOString().slice(0, 16).replace("T", "-").replace(":", "");
  // Brand the file itself — an Acme customer saving a recording should not end
  // up with the platform's name sitting in their downloads folder.
  //
  // Only the part before the first dot: the fallback display name is a domain
  // ("hello22.ai"), and slugifying that whole thing gives "hello22-ai", which
  // reads as a typo in a filename. A real brand name has no dot and is
  // unaffected.
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

/** Just the CALLER's words, for the classifier's "did anyone actually speak?"
 *  check. When no turn carries a recognisable role we can't tell who said what,
 *  so we return everything rather than wrongly reporting silence. */
function callerTranscriptText(raw: unknown): string {
  const turns = normalizeTranscript(raw);
  const roleKnown = turns.some((t) => t.role === "caller" || t.role === "agent");
  const kept = roleKnown ? turns.filter((t) => t.role === "caller") : turns;
  return kept.map((t) => t.text).join(" ");
}

/**
 * Did the AI actually book something on this call?
 *
 * The live booking tools write an Appointment row mid-call (services/booking/
 * engine.ts) but carry no call id, so we match on owner + time window: an
 * AI-sourced, confirmed appointment created between the call starting and now.
 * A 60s tail absorbs the gap between the tool firing and the end-of-call report.
 *
 * This is the ONLY thing that earns a "booking" badge. Deliberately narrow: a
 * false positive would tell an owner a table is in the diary when it isn't.
 * Best-effort — never throws, and "unsure" means "not a booking".
 */
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

  // Web calls are the owner trying their own agent. They still get a record +
  // notification (so the tester previews exactly what a real call produces), but
  // labelled "Test call" so it can never be mistaken for real business.
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

/** Everything the owner's post-call summary needs, already localised into their
 *  report language. Deliberately channel-agnostic: the same shape is built from
 *  a Vapi end-of-call report and from a browser test call. */
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
  /** Which brand owns the call — which is to say, which database it is in. A
   *  late-arriving recording URL is written there, and the recording link is
   *  signed with it. Required, not optional: an omitted brand would be
   *  silently wrong. `createdAt` is the other half of the call's key. */
  brandId: string | null;
  createdAt: Date;
}

/**
 * Send the owner their post-call summary on every channel they've enabled:
 * email (summary + recording + full transcript), SMS and WhatsApp.
 *
 * Shared by BOTH ingestion paths — the Vapi webhook for real phone calls and
 * `POST /` for browser test calls. Web calls start an inline assistant with no
 * assistantId, so Vapi never fires an end-of-call report for them; without this
 * being called from both places a test call produced an inbox record and nothing
 * else, which is exactly the thing the tester is supposed to rehearse.
 *
 * Fire-and-forget per channel: each is best-effort and independent, so a failing
 * SMS sender can never cost the owner their summary email, and nothing here can
 * break call ingestion.
 */
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

  // Best-effort owner SMS summary. Gated on the owner's plan including SMS
  // + an SMS sender being set (the admin's global on/off, in Admin → Phone
  // Numbers) + the owner having a mobile on file. Texts from the same sender
  // number as the test button.
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

/**
 * Translate a call's transcript into the owner's report language and cache it on
 * the call log, so the portal view reuses it for free. Returns the text to put in
 * the owner's email — the translation when it worked, the original otherwise.
 *
 * Only worth paying for when an email will actually send, so callers gate on that.
 */
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
  // Cached on the call, in the brand's database, with the marker that says
  // which language is cached. Always a call logged seconds ago, so it is never
  // archived and the row is the right place for the cache.
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

/** As `getConversionId`, but also returns the agent config — for the one caller
 *  that needs the owner's notification preferences. Kept separate so the hot
 *  read paths don't drag the whole config JSON along. */
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

    // Archived rows come back with empty transcript/analysis columns. The list
    // deliberately does NOT rehydrate them: a page can be 500 calls, and paying
    // 500 S3 round trips to fill a view that mostly renders scalars would trade
    // one slow query for something far worse. Instead each archived row is
    // flagged, and the client fetches the single call it actually opens through
    // `GET /:id`, which does hydrate. `blobKey` is a bucket path and stays on
    // the server.
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

    // One grouped aggregate, not the whole call history. This used to pull every
    // matching row into Node just to count it, so an owner with 50k calls moved
    // 50k rows across the wire to render four numbers — and the cost grew with
    // their history, which is exactly backwards for a stat card. Postgres counts
    // and sums off the (conversionId, createdAt) index instead.
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

/**
 * Log human-transfer call actions from Vapi webhook events so a live transfer
 * can be traced end-to-end in the server logs: when the AI requests a transfer,
 * whether the human answered, and how it ended (bridged / busy / no-answer →
 * fallback). Best-effort and noise-limited to transfer-relevant events.
 */
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

/**
 * Schedule the pre-cap wrap-up for a call that just went live.
 *
 * The cap is recomputed from the owner's entitlement + the platform ceiling
 * rather than read off the webhook, because Vapi's call payload doesn't carry
 * `maxDurationSeconds` — but it is the same function that stamped the assistant,
 * so the two agree.
 */
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

/**
 * Authenticate a Vapi webhook.
 *
 * This endpoint is public (Vapi has no IP allowlist) and, on the final
 * end-of-call report, it records billable usage and can auto-charge — so a
 * forged "call ended" POST could drain a customer's minutes or trigger a
 * charge. Vapi echoes the shared secret from the assistant's `server.secret`
 * (or the Vapi org-level Server URL secret) back in the `x-vapi-secret` header
 * on every message; we require it to match.
 *
 * Skips the check only when no secret is configured (local/dev), mirroring the
 * WhatsApp webhook — so set VAPI_WEBHOOK_SECRET (and the same value in Vapi) in
 * every real environment or this stays open. Constant-time compare.
 */
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

      // Vapi fires several events per call (status-update, transcript,
      // conversation-update, end-of-call-report, hang…). Only the final report
      // should produce a call log — otherwise one call becomes dozens of rows
      // and minutes get counted many times over.
      const eventType = message.type ?? body.type;

      // Trace every human-transfer-related call action so an "it transferred
      // immediately / didn't ring first" report can be diagnosed against what
      // Vapi actually did. Logs status changes, the transfer request, and any
      // transfer/forward outcome — but never the final report path below.
      logTransferAction(eventType, message, call);

      // A call that will be hard-cut at its duration cap gets told to close
      // itself a few seconds early, so the caller hears a goodbye instead of the
      // line going dead. Scheduled the moment the call goes live; cancelled below
      // if it ends on its own first. Never allowed to affect the webhook result.
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
          // Owner notification preferences. Toggles gate each channel; the summary*
          // overrides redirect summaries only (login/OTP always use the default).
          // Legacy configs (pre-feature) default to on via normalizeAutomations.
          const automations = normalizeAutomations(
            (conversion.agentConfig as { automations?: unknown })?.automations,
          );
          const customer = (message.customer ?? body.customer ?? {}) as Record<string, any>;
          const analysis = (message.analysis ?? body.analysis ?? {}) as Record<string, any>;
          // Vapi extracts the caller's details into structuredData (see the
          // analysisPlan in services/vapi.ts). Inbound calls carry no
          // customer.name, so the structured name is the primary source.
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

          // A placeholder ("unknown", "n/a", …) is not a name — the extraction
          // model writes those when the caller never said one, and storing them
          // would put "Unknown" in front of the owner everywhere downstream.
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
          // Transfer result: Vapi ends a bridged call with an "*-forwarded-*"
          // reason. If the caller asked for a human (requestedDepartment set) but
          // the call was NOT forwarded, the transfer didn't connect — flag it so
          // the owner can call them back.
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
          // The stored summary stays in the call's own language (the source of
          // truth); the portal translates it on view. For the OWNER's notifications
          // we translate a copy into their report language (best-effort → English).
          let summaryForOwner = summary;
          if (summary && needsTranslation(automations.reportLanguage)) {
            const localized = await translateText(summary, automations.reportLanguage);
            if (localized) summaryForOwner = localized;
          }
          const analysisJson =
            message.analysis ?? body.analysis ?? undefined;
          const artifact = (message.artifact ?? body.artifact ?? {}) as Record<string, any>;
          // Prefer Vapi's structured messages — they carry per-turn timing
          // (secondsFromStart), so the stored transcript gets the same
          // "Agent · 0:05" timestamps a web call has. Fall back to the plain
          // string transcript (no timing) when the structured messages aren't sent.
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
          // The Vapi call id — needed to pull the recording from Vapi's
          // authenticated download endpoint (storage.vapi.ai URLs are no longer
          // publicly fetchable). Written to its own column so playback survives
          // the transcript/analysis blobs being archived off to S3, and mirrored
          // into `analysis` for anything still reading the old shape.
          const vapiCallId =
            (typeof call.id === "string" && call.id) ||
            (typeof body.callId === "string" && body.callId) ||
            undefined;

          // What the call was about (booking / lead / enquiry / support / spam) —
          // drives the inbox badge + filter. The assistant already extracted it
          // into structuredData during the call, so this costs nothing; the
          // keyword heuristic only kicks in when it didn't. A successful Calendar
          // booking upgrades this to "booking" further down.
          // `structured` (not customer.number) is what feeds the lead rule: an
          // inbound call always has caller ID, so only details the caller
          // actually spoke count as "we captured them".
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

          // Public "More info" conversation page: unguessable slug + optional
          // expiry (0 validity hours = never expires). Generated for every call so
          // the link can be reused across channels; the SMS only includes it when
          // the owner has the toggle on.
          const validityHours = automations.conversationLinkValidityHours;
          const publicId = newPublicId();
          const shareExpiresAt =
            validityHours > 0 ? new Date(Date.now() + validityHours * 3_600_000) : null;

          // Resolved before the write: it decides which database this call's
          // transcript is allowed to be written to, so it cannot be an inline
          // await inside the payload.
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
            // The call id goes in its own column: `analysis` is archivable, so
            // a recording that could only be found through it would stop
            // playing the day the blob moved to S3.
            ...(vapiCallId ? { vapiCallId } : {}),
            // Still folded into the analysis JSON as well — harmless, and it
            // keeps the stored shape identical for anything reading a call
            // straight out of the DB.
            ...(analysisJson !== undefined || vapiCallId
              ? {
                  analysis: {
                    ...(analysisJson && typeof analysisJson === "object" ? analysisJson : {}),
                    ...(vapiCallId ? { vapiCallId } : {}),
                  } as TenantPrisma.InputJsonValue,
                }
              : {}),
          });

          // Junk is logged (so it's auditable and the inbox count is honest) but
          // never pushed as business: no interruption for the owner, and nothing
          // filed into their CRM. Filtering the noise out of the pipeline is the
          // point of classifying calls in the first place.
          // "" here means the caller never spoke — there is no lead to file, so
          // it gets the same treatment as spam for the CRM. The owner is still
          // notified: on a real call they have the number and may want to ring
          // back, which is exactly the opportunity this product exists to catch.
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
          // Post-call Google Calendar booking: if the AI captured a concrete
          // appointment (bookingRequested + preferredTimeISO) and the owner has
          // Calendar connected + booking on, create the event and invite the
          // caller. Fire-and-forget — never affects the call log or lead. The
          // transcript is passed as an LLM fallback when structuredData is absent.
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
            // Record usage, then settle: auto-charge the onboarding plan if the
            // trial just ended and re-sync the assistant cap. Order matters; all
            // best-effort.
            void recordUsage(conversion.userId, durationSec).then(() =>
              settleAfterCall(conversion.userId),
            );
          }
          void enforceTrialMinutes(conversion.userId);

          // Readable transcript text (Vapi sends a string; handle arrays too).
          const transcriptText = transcriptToPlainText(transcript);

          // The owner's EMAIL carries the full transcript. When they read reports
          // in another language, translate it now (best-effort) and CACHE it so the
          // portal view reuses it for free. Gated to when an email will actually
          // send, so we don't pay for a translation nobody sees.
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

    // Classify web/test calls the same way real phone calls are classified, so a
    // test call produces a real-looking record in the inbox — that's the whole
    // point of the tester: see exactly what a customer call will look like.
    // No Vapi structuredData here, so we ask OpenAI (cheap, and only on the
    // handful of test calls a user makes) and fall back to the keyword heuristic.
    const transcriptText = transcriptToPlainText(body.transcript);
    const bodyStructured = ((body.analysis as { structuredData?: unknown } | undefined)
      ?.structuredData ?? {}) as Record<string, unknown>;
    // Web calls carry NO Vapi structuredData (see the null structuredData on
    // every Web row), so without this read the lead rule could never fire on a
    // test call however much the AI collected. One request answers both "what
    // kind of call?" and "did we get a way to contact them?".
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

    // Public "More info" conversation page, same as a phone call gets — without
    // one the "More info" link in a summary SMS/WhatsApp has nowhere to point.
    // 0 validity hours = never expires.
    const validityHours = automations.conversationLinkValidityHours;
    const publicId = newPublicId();
    const shareExpiresAt =
      validityHours > 0 ? new Date(Date.now() + validityHours * 3_600_000) : null;

    // Pulled out of the posted analysis before the write so it can go in its own
    // column: `analysis` is archivable, and a recording reachable only through
    // it would stop playing the day that blob moved to S3.
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

    // Web calls now go through the SAME lead pipeline as real calls — inbox
    // record, intent badge, notification and CRM push — so the tester is an
    // honest end-to-end rehearsal instead of a half-wired preview. The only
    // difference is labelling: the notification says "Test call", and the CRM
    // lead is prefixed "[TEST]" (see deliverCallToCrm) so it's obvious in the
    // owner's real pipeline and trivial to delete.
    // Junk is the one thing that never propagates, test or not.
    const isTestCall = call.type === CallType.Web;
    if (intent !== "spam") notifyOwnerOfCall(req.user!.sub, call, { test: isTestCall });
    if (intent !== "spam" && intent !== "") {
      void deliverCallToCrm(req.user!.sub, call, { test: isTestCall, brandId: callBrandId });
    } else {
      console.log(`[intent] call ${call.id} (${intent || "silent"}) — CRM push suppressed`);
    }

    // ...and the post-call summary on every channel the owner has enabled. This
    // is the other half of that rehearsal: a browser call runs on an INLINE
    // assistant (no assistantId), so Vapi never fires an end-of-call report for
    // it and the webhook path above never runs — the summary has to be sent from
    // here or it is never sent at all.
    // The stored summary stays in the call's own language (the source of truth);
    // the owner's copy is translated into their report language, best-effort.
    let summaryForOwner = body.summary;
    if (body.summary && needsTranslation(automations.reportLanguage)) {
      const localized = await translateText(body.summary, automations.reportLanguage);
      if (localized) summaryForOwner = localized;
    }
    // The email carries the full transcript, so translate + cache it too — but
    // only when an email will actually send, so we don't pay for a translation
    // nobody sees.
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

    // Booking works on test calls too (the owner explicitly wants to verify it end
    // to end on their calendar). Web calls carry no Vapi structuredData, so pass the
    // transcript as a fallback — the booking service extracts the appointment from
    // it with the LLM when structured data is absent.
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

    // Track trial usage (atomic) + recompute status for every call, including
    // web calls — those minutes count against the trial/plan just like a real
    // call. If the trial just ran out this also auto-charges the onboarding plan
    // (via settleAfterCall → reconcileSubscription) and re-syncs the assistant's
    // per-call cap. The legacy Stripe enforcement stays as a fallback (no-op once
    // converted).
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

/** Translate a call's transcript into the owner's report language, lazily and
 *  cached: the first request translates + stores it, later ones return the cache.
 *  Falls back to the original transcript when no report language is set (or the
 *  translation fails). Returns `{ lang, transcript }`. */
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
    // Both the cache check and the translation itself read the transcript, so
    // it is pulled back from cold storage first if archived. Otherwise this
    // would translate an empty transcript and cache the result.
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
      // For an archived call the S3 object is the source of truth for the JSON
      // fields, so the cache goes there — written to the column it would just be
      // masked by the next hydrate, and every view would re-translate (and
      // re-bill) the same call. The two small scalar markers stay on the row
      // either way: they are never archived, and the cache check reads them
      // before anything touches storage.
      if (call.blobKey) await cacheArchivedTranslation(call.blobKey, transcriptOut);
      const key = { id: call.id, createdAt: call.createdAt };
      // The translated transcript and summary are personal data, so they follow
      // the same rule as the originals — a blob that has been archived is the
      // source of truth, otherwise the brand's own database, otherwise here.
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
    // The ownership check already reads the row, so it also carries back the
    // second half of the partitioned primary key — the update below then hits
    // one partition rather than probing all of them.
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

/** Owner correction of a call's category. Stamps intentSource="user" so no later
 *  AI pass can undo it — a badge the owner can't fix is a badge they stop
 *  trusting, and every correction is a labelled example for tuning the prompt. */
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

/**
 * Owner playback URL for a call recording. The dashboard's <audio> element can't
 * send a bearer token, so it can't hit the proxy directly with the raw id
 * anymore — it asks here (authenticated + scoped to the caller's own calls) for
 * a freshly-signed proxy URL. A short TTL is fine because a new one is minted
 * every time the owner opens the call, so their access never actually lapses.
 * Returns { url: null } when there's nothing to stream.
 */
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
    // `?share=1` is the owner copying a link to send to someone else, so it gets
    // a longer life than the dashboard's own player token — which is re-minted
    // every time they open a call and therefore never needs to outlive a session.
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

/**
 * Public recording proxy — streams a call's audio through our own domain so
 * links don't expose storage.vapi.ai. Reached without a login (a plain <audio>
 * element and email/CRM links can't send a bearer token), so access is gated by
 * a SIGNED, expiring token in the path — NOT the raw call-log id. The id is a
 * database key that appears in API responses, logs and browser history, so it
 * was never a secret; anyone who saw it could stream the audio forever. The
 * token carries the id, is signed with our key, and expires, so a leaked link
 * dies and the id alone is useless.
 *
 * As of Vapi's 2026 recording-auth change, the stored storage.vapi.ai URL is no
 * longer publicly fetchable — the audio must be pulled from Vapi's authenticated
 * endpoint using the call id we stash on the call's analysis. We try that first,
 * then fall back to the legacy stored URL (with our API key attached) for any old
 * call logged before we captured the call id.
 *
 * Byte ranges are honoured (`Accept-Ranges: bytes`): a player seeking mid-file
 * asks for a range, and answering 200-from-byte-0 makes the browser treat the
 * source as unseekable and restart playback at 0:00. We forward the client's
 * Range upstream and pass a 206 straight through; when the upstream ignores it
 * we slice the body ourselves, so seeking works either way.
 */
router.get(
  "/recording-file/:token",
  asyncHandler(async (req, res) => {
    // The path segment is a signed recording token, not the id. A bad/expired
    // token is a 404 (same as an unknown recording) — we don't distinguish, so
    // a probe learns nothing about which recordings exist.
    let claim: { callLogId: string; brandId: string };
    try {
      claim = verifyRecording(req.params.token);
    } catch {
      throw notFound("Recording not found");
    }
    // The token also names the brand: this route is served from the platform's
    // host for every brand, and the call is in that brand's own database.
    // `findFirst`, not `findUnique`: the id is half a primary key on a
    // partitioned table. Still at most one row — the id is a cuid.
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

    /** Preferred source is Vapi's authenticated download endpoint; older rows
     *  without a stored call id fall back to the saved URL, with our API key
     *  attached in case it points at Vapi storage. */
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

    // Some sources reject a ranged request outright (400/416) instead of just
    // ignoring the header. Retry plain so playback never breaks — the range is
    // then satisfied below by slicing the full body ourselves.
    if (rangeHeader && (!upstream || !upstream.ok)) upstream = await fetchUpstream(false);

    if (!upstream || !upstream.ok || !upstream.body) throw notFound("Recording not available");

    const contentType = upstream.headers.get("content-type") || "audio/wav";
    res.setHeader("Content-Type", contentType);
    // `?download=1` is the download button; everything else is the in-page player.
    // The player MUST stay `inline` — `attachment` makes the browser download
    // instead of streaming, which breaks the waveform and seeking.
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
    // Single-call reads are the one path that must always carry the full
    // transcript — it's what the detail panel opens on — so an archived call
    // costs one S3 GET here rather than showing an empty conversation. The
    // bucket key itself stays server-side, same as in the list.
    const { blobKey, blobArchivedAt, ...hydrated } = await hydrateCall(call);
    res.json({ ...hydrated, blobArchived: false });
  }),
);

export default router;
