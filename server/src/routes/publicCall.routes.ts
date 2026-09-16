import { Router } from "express";
import { asyncHandler } from "../lib/http.js";
import { prisma } from "../prisma.js";
import { escapeHtml } from "../lib/escapeHtml.js";
import { callerLabel } from "../lib/callerName.js";
import { emailGlobals } from "../services/emailTemplates.js";
import { normalizeAutomations } from "../lib/agentConfig.js";
import {
  translateText,
  translateTranscript,
  normalizeTranscript,
  needsTranslation,
} from "../services/summary.js";
import { publicApiBaseUrl } from "../env.js";
import { signRecording } from "../lib/jwt.js";
import { runWithBrand } from "../lib/brandContext.js";
import { vapiCallIdOf, hydrateCall } from "../services/callArchive.js";
import { callDb } from "../services/tenantDb.js";
import { updateCall } from "../services/callWrite.js";
import type { Prisma as TenantPrisma } from "@prisma/tenant-client";

// Public (no-auth) conversation page from the summary SMS "More info" link. Keyed by
// an unguessable slug with optional expiry; self-contained HTML, never indexed.

const router = Router();

type Turn = { role?: string; speaker?: string; text?: string; message?: string; content?: string };

/** Normalise the stored transcript (Vapi sends a string; we may store an array). */
function transcriptTurns(raw: unknown): { who: string; text: string }[] {
  if (typeof raw === "string") {
    return raw
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean)
      .map((line) => {
        const m = line.match(/^(agent|assistant|ai|bot|user|caller|customer|human)\s*[:\-]\s*(.*)$/i);
        if (m) return { who: /^(agent|assistant|ai|bot)$/i.test(m[1]) ? "Agent" : "Caller", text: m[2] };
        return { who: "", text: line };
      });
  }
  if (Array.isArray(raw)) {
    return (raw as Turn[])
      .map((t) => {
        const role = (t?.role || t?.speaker || "").toString().toLowerCase();
        const text = (t?.text ?? t?.message ?? t?.content ?? "").toString().trim();
        const who = /agent|assistant|ai|bot/.test(role) ? "Agent" : role ? "Caller" : "";
        return { who, text };
      })
      .filter((t) => t.text);
  }
  return [];
}

function formatDuration(sec: number): string {
  if (!sec || sec < 0) return "";
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return m ? `${m}m ${s}s` : `${s}s`;
}

const S = {
  page: "margin:0;background:#f4f4f5;font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;color:#18181b;line-height:1.55",
  card: "max-width:560px;margin:0 auto;padding:16px",
  brand: "font-size:18px;font-weight:700;padding:20px 0 12px",
  panel: "background:#fff;border:1px solid #e4e4e7;border-radius:14px;padding:20px 22px;margin-bottom:16px",
  label: "font-size:12px;font-weight:600;letter-spacing:.04em;text-transform:uppercase;color:#71717a;margin:0 0 4px",
  value: "font-size:16px;margin:0 0 16px;word-wrap:break-word",
  h2: "font-size:14px;font-weight:700;margin:0 0 12px;color:#3f3f46",
  turnAgent: "margin:0 0 10px;padding:10px 12px;background:#eef2ff;border-radius:10px;font-size:14px",
  turnCaller: "margin:0 0 10px;padding:10px 12px;background:#f4f4f5;border-radius:10px;font-size:14px",
  who: "display:block;font-size:11px;font-weight:700;color:#6366f1;margin-bottom:2px",
  whoCaller: "display:block;font-size:11px;font-weight:700;color:#71717a;margin-bottom:2px",
  muted: "font-size:13px;color:#71717a;margin:0",
};

function shell(title: string, inner: string): string {
  const { app_name } = emailGlobals();
  return (
    `<!doctype html><html lang="en"><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width, initial-scale=1">` +
    `<meta name="robots" content="noindex,nofollow">` +
    `<title>${escapeHtml(title)} · ${escapeHtml(app_name)}</title></head>` +
    `<body style="${S.page}"><div style="${S.card}">` +
    `<div style="${S.brand}">${escapeHtml(app_name)}</div>` +
    inner +
    `</div></body></html>`
  );
}

function notice(title: string, message: string): string {
  return shell(
    title,
    `<div style="${S.panel}"><p style="${S.value}"><strong>${escapeHtml(title)}</strong></p>` +
      `<p style="${S.muted}">${escapeHtml(message)}</p></div>`,
  );
}

router.get(
  "/:publicId",
  asyncHandler(async (req, res) => {
    // Served from the platform host for every brand, so the slug alone can't say which
    // tenant DB to open — the Main share index names the brand and the partitioned key.
    const share = await prisma.callShare.findUnique({ where: { publicId: req.params.publicId } });
    const db = share ? await callDb(share.brandId).catch(() => null) : null;
    const found =
      share && db
        ? await db.callLog.findFirst({
            where: { id: share.callId, createdAt: share.callCreatedAt },
            select: {
              id: true,
              conversionId: true,
              callerName: true,
              callerNumber: true,
              purpose: true,
              summary: true,
              summaryTranslated: true,
              durationSec: true,
              recordingUrl: true,
              vapiCallId: true,
              analysis: true,
              transcript: true,
              transcriptTranslated: true,
              transcriptTranslatedLang: true,
              // Set when the three blobs above were aged out to S3 — `hydrateCall`
              // below pulls them back so a shared link keeps working forever.
              blobKey: true,
              createdAt: true,
              shareExpiresAt: true,
            },
          })
        : null;

    if (!share || !found) {
      res.status(404).type("text/html").send(notice("Conversation not found", "This link is invalid or the conversation has been removed."));
      return;
    }
    // The link may be years old and the transcript aged out to S3 — pull it back.
    const call = await hydrateCall(found);
    // Paint everything from here on as the brand that owns the call, not as
    // whatever the API host resolves to — which is the platform, for everyone.
    const asOwner = <T,>(fn: () => T): T => runWithBrand(share.brandId, fn);
    // The owner's agent settings (report language), from the brand's database.
    const conversion = await (await callDb(share.brandId)).conversion.findUnique({
      where: { id: found.conversionId },
      select: { agentConfig: true },
    });

    if (call.shareExpiresAt && call.shareExpiresAt.getTime() < Date.now()) {
      res
        .status(410)
        .type("text/html")
        .send(asOwner(() => notice("Link expired", "This conversation link has expired and is no longer available.")));
      return;
    }

    // Owner report language: show the summary + transcript translated (reusing the
    // cache the email/portal populate, else translating on first view and caching).
    const lang = normalizeAutomations(
      (conversion?.agentConfig as { automations?: unknown })?.automations,
    ).reportLanguage;
    let summaryOut = call.summary || "";
    let transcriptForTurns: unknown = call.transcript;
    if (needsTranslation(lang)) {
      const cachedLangMatches = call.transcriptTranslatedLang === lang;
      let freshSummary: string | undefined;
      let freshTranscript: unknown;

      // Summary — trust the cache only when its language marker matches.
      if (cachedLangMatches && call.summaryTranslated) {
        summaryOut = call.summaryTranslated;
      } else if (call.summary) {
        const t = await translateText(call.summary, lang);
        if (t) {
          summaryOut = t;
          freshSummary = t;
        }
      }

      // Transcript — serve the cache when the language matches, else translate.
      if (cachedLangMatches && call.transcriptTranslated) {
        transcriptForTurns = call.transcriptTranslated;
      } else {
        const turns = normalizeTranscript(call.transcript);
        if (turns.length) {
          const tt = await translateTranscript(
            turns.map((t) => ({ role: t.role, text: t.text })),
            lang,
          );
          if (tt) {
            const merged = tt.map((t, i) => ({ ...t, at: turns[i]?.at }));
            transcriptForTurns = merged;
            freshTranscript = merged;
          }
        }
      }

      // Persist whatever we translated fresh so later views (and the portal) are free.
      if (freshSummary !== undefined || freshTranscript !== undefined) {
        // Cache in the brand's DB with the language marker; createdAt is passed so the
        // write hits the call's own monthly partition.
        await updateCall(
          share.brandId,
          { id: call.id, createdAt: call.createdAt },
          {
            ...(freshSummary !== undefined ? { summaryTranslated: freshSummary } : {}),
            ...(freshTranscript !== undefined
              ? {
                  transcriptTranslated: freshTranscript as TenantPrisma.InputJsonValue,
                  transcriptTranslatedLang: lang,
                }
              : {}),
          },
        ).catch(() => {});
      }
    }

    const rows: string[] = [];
    const add = (label: string, value: string) => {
      if (value) rows.push(`<p style="${S.label}">${escapeHtml(label)}</p><p style="${S.value}">${escapeHtml(value)}</p>`);
    };
    add("Caller", callerLabel(call.callerName));
    add("Number", call.callerNumber || "");
    add("Purpose", call.purpose || "");
    add("Summary", summaryOut || "");
    add("Duration", formatDuration(call.durationSec));
    add("When", call.createdAt.toUTCString());

    let recording = "";
    // Proxy path uses a signed, expiring token, not the raw call id, so this page
    // can't be scraped for a permanent audio link.
    const hasRecording = Boolean(call.recordingUrl) || Boolean(vapiCallIdOf(call));
    if (hasRecording) {
      const src = `${publicApiBaseUrl}/api/calls/recording-file/${signRecording(call.id, share.brandId, "30d")}`;
      recording =
        `<div style="${S.panel}"><h2 style="${S.h2}">Recording</h2>` +
        `<audio controls preload="none" style="width:100%">` +
        `<source src="${escapeHtml(src)}"></audio></div>`;
    }

    const turns = transcriptTurns(transcriptForTurns);
    let transcript = "";
    if (turns.length) {
      const body = turns
        .map((t) => {
          if (t.who === "Agent")
            return `<div style="${S.turnAgent}"><span style="${S.who}">Agent</span>${escapeHtml(t.text)}</div>`;
          if (t.who === "Caller")
            return `<div style="${S.turnCaller}"><span style="${S.whoCaller}">Caller</span>${escapeHtml(t.text)}</div>`;
          return `<div style="${S.turnCaller}">${escapeHtml(t.text)}</div>`;
        })
        .join("");
      transcript = `<div style="${S.panel}"><h2 style="${S.h2}">Transcript</h2>${body}</div>`;
    }

    res
      .status(200)
      .type("text/html")
      .send(
        asOwner(() =>
          shell("Call conversation", `<div style="${S.panel}">${rows.join("")}</div>${recording}${transcript}`),
        ),
      );
  }),
);

export default router;
