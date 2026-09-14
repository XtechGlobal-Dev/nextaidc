import nodemailer from "nodemailer";
import type { Transporter } from "nodemailer";
import { notImplemented } from "../lib/http.js";
import { formatDateDMY } from "../lib/date.js";
import { getEffective, integrationConfiguredFor } from "./settings.js";
import { traceCall } from "./apiTrace.js";
import { platformDomain, publicApiBaseUrl } from "../env.js";
import { brandAppUrl } from "../lib/brandUrls.js";
import { escapeHtml } from "../lib/escapeHtml.js";
import { prisma } from "../prisma.js";
import { planeOf } from "./tenantDb.js";
import { signUnsubscribe } from "../lib/jwt.js";
import { renderEmail, getEmailBranding, isUnsubscribable } from "./emailTemplates.js";
import { currentBrandId } from "../lib/brandContext.js";
import { cachedBrand } from "./brands.js";

// Keyed by SMTP credentials: a brand with its own relay must never send through
// another brand's server.
const transporters = new Map<string, Transporter>();

/** SMTP transport for a brand (brand override → platform DB → env). */
function transport(brandId?: string | null): Transporter {
  // Brand-aware: a tenant's own relay works even with no platform SMTP.
  if (!integrationConfiguredFor("email", brandId))
    throw notImplemented("Email is not configured (add SMTP settings in Admin → Settings)");
  const host = getEffective("smtp.host", brandId);
  const port = Number(getEffective("smtp.port", brandId)) || 587;
  const user = getEffective("smtp.user", brandId);
  const pass = getEffective("smtp.pass", brandId);
  const sig = `${host}:${port}:${user}:${pass}`;
  let existing = transporters.get(sig);
  if (!existing) {
    existing = nodemailer.createTransport({
      host,
      port,
      secure: port === 465,
      // Omit auth entirely for relays that don't require it.
      auth: user || pass ? { user, pass } : undefined,
    });
    // Bounded so a stale identity can't pin a connection forever.
    if (transporters.size > 16) transporters.clear();
    transporters.set(sig, existing);
  }
  return existing;
}

function fromAddress(brandId?: string | null): string {
  // Fallback names the deployment's own domain, never the original one.
  return getEffective("smtp.from", brandId) || `${platformDomain} <support@${platformDomain}>`;
}

/** Support-handoff inbox: the dedicated setting, else the From address. Always non-empty so the widget can show it. */
export function supportInboxAddress(): string {
  const brandId = currentBrandId();
  const explicit = getEffective("smtp.supportInbox", brandId).trim();
  if (explicit) return explicit;
  const from = fromAddress(brandId);
  const m = from.match(/<([^>]+)>/);
  return (m ? m[1] : from).trim();
}

export async function sendEmail(opts: {
  to: string;
  subject: string;
  html: string;
  text?: string;
  from?: string;
  headers?: Record<string, string>;
  /** Brand to send as. Defaults to the ambient one; pass explicitly from background work. */
  brandId?: string | null;
}) {
  const { from, brandId, ...rest } = opts;
  const tenant = brandId !== undefined ? brandId : currentBrandId();
  await traceCall(
    "smtp",
    "/sendMail",
    () => transport(tenant).sendMail({ from: from || fromAddress(tenant), ...rest }),
    { units: 1 },
  );
}

/** Unsubscribe link + one-click headers. "opted-out" means skip the send; null means unknown address, send with no link. */
async function unsubscribeContext(
  to: string,
): Promise<{ url: string; headers: Record<string, string> } | "opted-out" | null> {
  // Recipient may live in a brand's DB (directory says which) or in Main.
  const hit = await prisma.customerDirectory
    .findFirst({ where: { email: to }, select: { userId: true, brandId: true } })
    .catch(() => null);
  const user = await planeOf(hit?.brandId ?? null)
    .then((db) =>
      db.user.findUnique({ where: hit ? { id: hit.userId } : { email: to }, select: { id: true, emailOptOutAt: true } }),
    )
    .catch(() => null);
  if (!user) return null;
  if (user.emailOptOutAt) return "opted-out";
  const url = `${publicApiBaseUrl}/api/unsubscribe?token=${encodeURIComponent(signUnsubscribe(user.id))}`;
  return {
    url,
    headers: {
      // RFC 2369 + RFC 8058 one-click, so Gmail/Apple Mail show a native button.
      "List-Unsubscribe": `<${url}>`,
      "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
    },
  };
}

/** Renders an editable system-email template and sends it. Returns false when the template is disabled or unknown. */
export async function sendTemplate(
  key: string,
  to: string,
  vars: Record<string, string | number | undefined>,
): Promise<boolean> {
  // Notification mails honour opt-out; everyone else gets a tokenized link + header.
  let unsubscribeUrl: string | undefined;
  let headers: Record<string, string> | undefined;
  if (isUnsubscribable(key)) {
    const ctx = await unsubscribeContext(to);
    if (ctx === "opted-out") return false;
    if (ctx) {
      unsubscribeUrl = ctx.url;
      headers = ctx.headers;
    }
  }

  const rendered = await renderEmail(key, vars, { unsubscribeUrl });
  if (!rendered || !rendered.enabled) return false;

  // Brand name wins over the platform From name: tenant mail must not wear the platform's name.
  const brandId = currentBrandId();
  let from: string | undefined;
  try {
    const brandName = cachedBrand(brandId)?.name?.trim();
    const fromName = brandName || (await getEmailBranding()).fromName;
    const addr = fromAddress(brandId).match(/[\w.+-]+@[\w.-]+/)?.[0];
    if (fromName && addr) from = `${fromName} <${addr}>`;
  } catch {
    /* fall back to the raw SMTP from */
  }

  await sendEmail({
    to,
    subject: rendered.subject,
    html: rendered.html,
    text: rendered.text,
    from,
    headers,
    brandId,
  });
  return true;
}

function fmtDate(d: Date): string {
  return formatDateDMY(d);
}

/** Lapsed trial got a grace window; number stays reserved until graceEndsAt. */
export function graceStartedEmail(opts: {
  ownerEmail: string;
  fullName: string;
  graceDays: number;
  graceEndsAt: Date;
  number: string;
}) {
  return sendTemplate("grace_started", opts.ownerEmail, {
    user_name: opts.fullName,
    grace_days: opts.graceDays,
    number: opts.number,
    grace_until: fmtDate(opts.graceEndsAt),
  });
}

/** Grace-window nudge; `final` flips to the last-24-hours template. */
export function graceWarningEmail(opts: {
  ownerEmail: string;
  fullName: string;
  daysRemaining: number;
  graceEndsAt: Date;
  number: string;
  final: boolean;
}) {
  const until = fmtDate(opts.graceEndsAt);
  if (opts.final) {
    return sendTemplate("grace_final_warning", opts.ownerEmail, {
      user_name: opts.fullName,
      number: opts.number,
      grace_until: until,
    });
  }
  return sendTemplate("grace_warning", opts.ownerEmail, {
    user_name: opts.fullName,
    window: `${opts.daysRemaining} day${opts.daysRemaining === 1 ? "" : "s"}`,
    days_remaining: opts.daysRemaining,
    number: opts.number,
    grace_until: until,
  });
}

/** Confirm the grace window lapsed and the number has been released. */
export function graceEndedEmail(opts: { ownerEmail: string; fullName: string; number: string }) {
  return sendTemplate("grace_ended", opts.ownerEmail, {
    user_name: opts.fullName,
    number: opts.number,
  });
}

/** Tell the owner an admin has suspended their account. */
export function accountSuspendedEmail(opts: {
  ownerEmail: string;
  fullName: string;
  supportEmail?: string;
  reason?: string;
}) {
  return sendTemplate("account_suspended", opts.ownerEmail, {
    user_name: opts.fullName,
    reason: opts.reason?.trim() ? `Reason: ${opts.reason.trim()}` : "",
    ...(opts.supportEmail?.trim() ? { support_email: opts.supportEmail.trim() } : {}),
  });
}

/** Tell the owner an admin has lifted their suspension. */
export function accountReactivatedEmail(opts: { ownerEmail: string; fullName: string }) {
  return sendTemplate("account_reactivated", opts.ownerEmail, {
    user_name: opts.fullName,
    login_url: brandAppUrl("/login"),
  });
}

/** Welcome the owner once their AI receptionist is live on its dedicated number. */
export function numberAssignedEmail(opts: {
  ownerEmail: string;
  fullName: string;
  businessName?: string;
  number: string;
  trialDays: number;
  trialMinutes: number;
}) {
  const business = opts.businessName?.trim();
  return sendTemplate("number_assigned", opts.ownerEmail, {
    user_name: opts.fullName,
    business_suffix: business ? ` for ${business}` : "",
    number: opts.number,
    // Spaceless form for the dial code so callers don't dial the spaces.
    number_plain: opts.number.replace(/[^\d+]/g, ""),
    trial_minutes: opts.trialMinutes,
    trial_days: opts.trialDays,
    forwarding_url: brandAppUrl("/dashboard/settings"),
  });
}

/** Notify the owner their free trial converted to a paid (active) plan. */
export function planActivatedEmail(opts: {
  ownerEmail: string;
  fullName: string;
  planName: string;
  includedMinutes: number;
  number?: string;
  renewalDate?: string;
}) {
  const minutes =
    opts.includedMinutes > 0 ? `${opts.includedMinutes} minutes per cycle` : "Unlimited minutes";
  return sendTemplate("plan_activated", opts.ownerEmail, {
    user_name: opts.fullName,
    plan_name: opts.planName,
    included_minutes: minutes,
    // Trailing newline keeps it on its own line above "Renews:"; empty when no
    // number so the line collapses cleanly.
    number_line: opts.number ? `AI number: ${opts.number}\n` : "",
    renewal_line: opts.renewalDate ? `Renews: ${opts.renewalDate}` : "",
  });
}

/** Warn the owner when call-minute usage crosses a threshold (50/80/90%). */
export function usageThresholdEmail(opts: {
  ownerEmail: string;
  fullName: string;
  threshold: number;
  minutesUsed: number;
  minutesAllocated: number;
  minutesRemaining: number;
  isTrial: boolean;
}) {
  const what = opts.isTrial ? "free trial" : "plan";
  const used = Math.round(opts.minutesUsed * 10) / 10;
  const left = Math.round(opts.minutesRemaining * 10) / 10;
  const lead =
    opts.threshold >= 90
      ? `You've used ${opts.threshold}% of your ${what} call minutes — you're almost out.`
      : `You've used ${opts.threshold}% of your ${what} call minutes.`;
  const cta = opts.isTrial
    ? "Pick a plan to keep your AI receptionist answering once your trial minutes run out."
    : "Top up or upgrade your plan to keep your AI receptionist answering without interruption.";
  return sendTemplate("usage_threshold", opts.ownerEmail, {
    user_name: opts.fullName,
    threshold: opts.threshold,
    lead,
    minutes_used: used,
    minutes_allocated: opts.minutesAllocated,
    minutes_remaining: left,
    cta,
  });
}

/** Owner post-call email — AI summary + recording link + full transcript. */
export function callSummaryEmail(opts: {
  ownerEmail: string;
  callerName: string;
  callerNumber?: string;
  summary?: string;
  transcript?: string;
  recordingUrl?: string;
}) {
  // Number rides along with the name so no template change is needed.
  const callerLabel = opts.callerNumber?.trim()
    ? `${opts.callerName} (${opts.callerNumber.trim()})`
    : opts.callerName;
  return sendTemplate("call_summary", opts.ownerEmail, {
    caller_name: callerLabel,
    summary_block: opts.summary ? `AI summary\n${opts.summary}` : "",
    recording_block: opts.recordingUrl ? `Recording: ${opts.recordingUrl}` : "",
    transcript_block: opts.transcript ? `Transcript\n${opts.transcript}` : "",
  });
}

/** Mails a chat handoff to the support inbox. Details may be missing; the transcript is the ground truth. */
export function supportHandoffEmail(opts: {
  accountEmail: string;
  accountName: string;
  details: { name?: string; business?: string; email?: string; topic?: string; summary?: string };
  transcript: { role: string; content: string }[];
}) {
  const { accountEmail, accountName, details, transcript } = opts;
  const rows: [string, string][] = [
    ["Name", details.name || accountName],
    ["Business", details.business || ""],
    ["Contact email", details.email || accountEmail],
    ["Topic", details.topic || ""],
    ["Account", `${accountName} <${accountEmail}>`],
  ];
  const transcriptText = transcript
    .map((m) => `${m.role === "user" ? "Customer" : "Assistant"}: ${m.content}`)
    .join("\n");

  const htmlParts: string[] = [
    `<h2>Support chat handoff${details.topic ? ` — ${escapeHtml(details.topic)}` : ""}</h2>`,
    `<table cellpadding="4">${rows
      .filter(([, v]) => v)
      .map(([k, v]) => `<tr><td><b>${k}</b></td><td>${escapeHtml(v)}</td></tr>`)
      .join("")}</table>`,
  ];
  const textParts: string[] = [
    "Support chat handoff",
    rows
      .filter(([, v]) => v)
      .map(([k, v]) => `${k}: ${v}`)
      .join("\n"),
  ];
  if (details.summary) {
    htmlParts.push(`<h3>Summary</h3><p>${escapeHtml(details.summary)}</p>`);
    textParts.push(`Summary:\n${details.summary}`);
  }
  htmlParts.push(
    `<h3>Conversation</h3><pre style="white-space:pre-wrap;font-family:inherit;font-size:14px">${escapeHtml(
      transcriptText,
    )}</pre>`,
  );
  textParts.push(`Conversation:\n${transcriptText}`);

  return sendEmail({
    to: supportInboxAddress(),
    subject: `Support handoff: ${details.name || accountName}${details.topic ? ` — ${details.topic}` : ""}`,
    html: htmlParts.join(""),
    text: textParts.join("\n\n"),
  });
}

/** Customer-side handoff confirmation; the widget promises an email, so send one. */
export function handoffAckEmail(opts: { to: string; name: string; topic?: string; summary?: string }) {
  const { to, name, topic, summary } = opts;
  const what = summary || topic;
  return sendEmail({
    to,
    subject: "We've received your request — our team will be in touch",
    html:
      `<p>Hi ${escapeHtml(name)},</p>` +
      `<p>Thanks for reaching out! Your conversation has been passed to our support team` +
      `${what ? ` regarding <b>${escapeHtml(what)}</b>` : ""}.</p>` +
      `<p>Someone from the team will email you shortly. You can also reply to this email ` +
      `if you'd like to add anything.</p>`,
    text:
      `Hi ${name},\n\n` +
      `Thanks for reaching out! Your conversation has been passed to our support team` +
      `${what ? ` regarding: ${what}` : ""}.\n\n` +
      `Someone from the team will email you shortly. You can also reply to this email ` +
      `if you'd like to add anything.`,
  });
}
