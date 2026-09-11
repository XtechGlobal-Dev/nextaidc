import { prisma } from "../prisma.js";
import { allTenants, tenantFor } from "./tenantDb.js";
import { brandIdForOwner } from "./customerDirectory.js";
import { sendEmail } from "./email.js";
import { integrationsStatus } from "./settings.js";
import { escapeHtml } from "../lib/escapeHtml.js";
import { brandDisplayName } from "../lib/brandUrls.js";

export interface DigestStats {
  callsHandled: number;
  leadsCaptured: number;
  minutesUsed: number;
  missed: number;
  topIntents: { intent: string; count: number }[];
}

export interface UserDigest {
  subject: string;
  html: string;
  stats: DigestStats;
}

const REPORTS_LAST_RUN_KEY = "reports.lastRunAt";

function startOfWindow(days = 7): Date {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000);
}

/** Pull a string "intent" out of a call's analysis JSON, if present. */
function extractIntent(analysis: unknown): string | null {
  if (typeof analysis !== "object" || analysis === null) return null;
  const a = analysis as Record<string, unknown>;
  const raw = a.intent ?? a.topic ?? a.category;
  return typeof raw === "string" && raw.trim() ? raw.trim() : null;
}

/**
 * Build a 7-day digest for one user. Returns null when the user has no profile
 * (e.g. an admin or reseller account) so callers can skip them.
 */
export async function buildUserDigest(userId: string): Promise<UserDigest | null> {
  const brandId = await brandIdForOwner(userId);
  if (!brandId) return null; // the platform's own people have no receptionist
  const db = await tenantFor(brandId);
  const user = await db.user.findUnique({
    where: { id: userId },
    include: { profile: true, conversion: true },
  });
  if (!user || !user.profile) return null;

  const since = startOfWindow(7);
  const calls = user.conversion
    ? await db.callLog.findMany({
        where: { conversionId: user.conversion.id, createdAt: { gte: since } },
        select: { outcome: true, durationSec: true, analysis: true },
      })
    : [];

  const callsHandled = calls.length;
  const leadsCaptured = calls.filter((c) => c.outcome === "completed").length;
  const missed = calls.filter((c) => c.outcome === "missed").length;
  const minutesUsed = Math.round(calls.reduce((s, c) => s + c.durationSec, 0) / 60);

  const intentCounts = new Map<string, number>();
  for (const c of calls) {
    const intent = extractIntent(c.analysis);
    if (intent) intentCounts.set(intent, (intentCounts.get(intent) ?? 0) + 1);
  }
  const topIntents = [...intentCounts.entries()]
    .map(([intent, count]) => ({ intent, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 5);

  const stats: DigestStats = { callsHandled, leadsCaptured, minutesUsed, missed, topIntents };

  const appName = brandDisplayName(brandId);
  const businessName = user.profile.businessName || "your business";
  const intentRows = topIntents.length
    ? `<ul>${topIntents.map((i) => `<li>${i.intent} — ${i.count}</li>`).join("")}</ul>`
    : "";

  const html =
    `<h2>Your weekly ${escapeHtml(appName)} digest</h2>` +
    `<p>Hi ${user.fullName}, here's how your AI receptionist did for ${businessName} this week:</p>` +
    `<ul>` +
    `<li><b>${callsHandled}</b> calls handled</li>` +
    `<li><b>${leadsCaptured}</b> leads captured</li>` +
    `<li><b>${minutesUsed}</b> minutes on calls</li>` +
    `<li><b>${missed}</b> missed</li>` +
    `</ul>` +
    (intentRows ? `<p><b>Top topics:</b></p>${intentRows}` : "") +
    `<p>Log in to your dashboard for the full picture.</p>`;

  return { subject: `Your weekly ${appName} digest — ${callsHandled} calls`, html, stats };
}

/**
 * Build and send the weekly digest to every customer with a profile.
 * Best-effort per user; emails only go out when SMTP is configured.
 */
export async function sendDigests(): Promise<{ sent: number; skipped: number }> {
  // Every brand's customers, from each brand's own database.
  const users: { id: string; email: string }[] = [];
  for (const { db } of await allTenants()) {
    users.push(
      ...(await db.user.findMany({
        where: { role: "USER", profile: { isNot: null } },
        select: { id: true, email: true },
      })),
    );
  }

  const canEmail = integrationsStatus().email;
  let sent = 0;
  let skipped = 0;

  for (const u of users) {
    try {
      const digest = await buildUserDigest(u.id);
      if (!digest) {
        skipped++;
        continue;
      }
      if (canEmail) {
        await sendEmail({ to: u.email, subject: digest.subject, html: digest.html });
        sent++;
      } else {
        skipped++;
      }
    } catch {
      skipped++;
    }
  }

  await prisma.platformSetting.upsert({
    where: { key: REPORTS_LAST_RUN_KEY },
    update: { value: new Date().toISOString(), isSecret: false },
    create: { key: REPORTS_LAST_RUN_KEY, value: new Date().toISOString(), isSecret: false },
  });

  return { sent, skipped };
}

export async function getLastDigestRun(): Promise<string | null> {
  const row = await prisma.platformSetting.findUnique({ where: { key: REPORTS_LAST_RUN_KEY } });
  return row?.value ?? null;
}

export { REPORTS_LAST_RUN_KEY };
