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

/* One transport per distinct SMTP identity. A white-label brand may bring its
 * own relay, so a single cached transport would send Brand B's mail through
 * Brand A's server; keying the cache by the credentials keeps each brand on its
 * own connection while still reusing it across sends. */
const transporters = new Map<string, Transporter>();

/** Build (or reuse) an SMTP transport from the effective settings for a brand
 *  (brand override → platform DB → env). */
function transport(brandId?: string | null): Transporter {
  // Brand-aware: a tenant with its own relay can send even when the platform
  // itself has no SMTP configured.
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
    // Bounded on purpose: brands are few, but a stale identity should not pin a
    // connection forever. Cheapest correct policy — clear and rebuild.
    if (transporters.size > 16) transporters.clear();
    transporters.set(sig, existing);
  }
  return existing;
}

function fromAddress(brandId?: string | null): string {
  // Last resort when nothing is configured anywhere: name the deployment's own
  // domain rather than the one this codebase was first written for.
  return getEffective("smtp.from", brandId) || `${platformDomain} <support@${platformDomain}>`;
}

/** Inbox that receives support-chat handoffs: the dedicated setting when set,
 *  otherwise the bare address from the From header. Always non-empty, so the
 *  chat widget can also surface it as a "email us directly" fallback. */
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
  /** Send as this white-label brand. Defaults to the request's ambient brand,
   *  so ordinary call sites need no change; pass it explicitly from background
   *  work (schedulers, webhooks), where there is no request to inherit from. */
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

/** Build the public unsubscribe link + one-click List-Unsubscribe headers for a
 *  recipient. Returns null when the user has opted out (caller should skip the
 *  send) or when the address isn't a known user (send normally, no link). */
async function unsubscribeContext(
  to: string,
): Promise<{ url: string; headers: Record<string, string> } | "opted-out" | null> {
  // The recipient may be one of a brand's people (in that brand's database —
  // the directory says which) or one of the platform's own (in Main).
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
      // RFC 2369 + RFC 8058 one-click: lets Gmail/Apple Mail surface a native
      // "Unsubscribe" button that POSTs to the URL without the user visiting it.
      "List-Unsubscribe": `<${url}>`,
      "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
    },
  };
}

/**
 * Render an editable system-email template and send it. No-op (returns false)
 * when the template is disabled by an admin or unknown. Applies the branded
 * "From name" from Admin → System Emails on top of the SMTP from address.
 */
export async function sendTemplate(
  key: string,
  to: string,
  vars: Record<string, string | number | undefined>,
): Promise<boolean> {
  // Notification emails honour the per-recipient unsubscribe: skip opted-out
  // users entirely, and give everyone else a tokenized footer link + one-click
  // List-Unsubscribe header.
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

  // Apply the From name, keeping the SMTP envelope address. On a white-label
  // brand the brand's own name wins — mail from a tenant must not arrive
  // wearing the platform's name — otherwise the editable platform From name.
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

/** Tell the owner their lapsed trial bought them a grace window — their number
 *  stays reserved until graceEndsAt, after which it's released to the pool. */
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

/** Nudge during the grace window: recharge soon or lose the number. `final`
 *  flips to the last-24-hours template. */
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
  // Append the caller's number to the name (used in both the subject and body)
  // so the owner can see exactly which number rang — no template change needed.
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

/** Support-chat handoff — the widget user asked for a human, so mail the
 *  conversation to the support inbox. Details come from what the assistant
 *  collected in-chat (any may be missing); the transcript is the ground truth. */
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

/** Confirmation to the customer that their chat handoff reached the team — the
 *  widget tells them to "keep an eye on your inbox", so back that up with a
 *  real email at the address they gave the assistant. */
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
