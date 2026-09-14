import type { SmsInfoItem } from "@/types";

// "Text Info to Callers" catalogue + rendering rules. Mirrors server/src/lib/smsInfoItems.ts
// (the server is the authority on what's sent; this drives the live counter) — keep in step.

/** One GSM-7 segment. Clamped before Twilio so a message is never split or billed as multi-part. */
export const SMS_MAX_LENGTH = 160;

/** Max ENABLED rows (seeded + custom). Keeps the tool's `topic` enum tight and per-call spend bounded;
 *  disabled drafts don't count. */
export const MAX_ENABLED_SMS_INFO_ITEMS = 3;

/** Safety bound on the stored array; the limit owners work against is MAX_ENABLED_SMS_INFO_ITEMS. */
export const MAX_SMS_INFO_ITEMS = MAX_ENABLED_SMS_INFO_ITEMS * 2;

/** The business details a template can interpolate. */
export interface SmsInfoValues {
  business: string;
  website: string;
  email: string;
  address: string;
  phone: string;
  hours: string;
}

export const EMPTY_SMS_INFO_VALUES: SmsInfoValues = {
  business: "",
  website: "",
  email: "",
  address: "",
  phone: "",
  hours: "",
};

/** Shown under the template editor so owners know what they can interpolate. */
export const SMS_PLACEHOLDERS: { token: string; label: string }[] = [
  { token: "{{business}}", label: "Business name" },
  { token: "{{website}}", label: "Website" },
  { token: "{{email}}", label: "Email" },
  { token: "{{address}}", label: "Address" },
  { token: "{{phone}}", label: "Phone number" },
  { token: "{{hours}}", label: "Opening hours" },
];

/** `business` is decoration and tidies away when blank. Every other placeholder IS the thing asked
 *  for, so a blank one hides the item rather than texting a gap. */
const OPTIONAL_PLACEHOLDERS = new Set(["business"]);

/** Starter catalogue, all OFF so a fresh account never texts a caller until set up on purpose.
 *  No booking link on purpose — `sendBookingLink` owns that, and two tools for one link makes the model pick badly. */
export const SEEDED_SMS_INFO_ITEMS: SmsInfoItem[] = [
  {
    id: "sms_website",
    key: "website",
    label: "Website link",
    enabled: false,
    whenToUse: "the caller asks for the website, your site, or where to find you online",
    template: "Thanks for calling {{business}}. Our website: {{website}}",
  },
  {
    id: "sms_email",
    key: "email",
    label: "Email address",
    enabled: false,
    whenToUse: "the caller asks for an email address, or where to send photos or documents",
    template: "Thanks for calling {{business}}. You can email us at {{email}}",
  },
  {
    id: "sms_address",
    key: "address",
    label: "Address & directions",
    enabled: false,
    whenToUse: "the caller asks where you are, for your address, or for directions",
    template: "{{business}} is at {{address}}. See you soon!",
  },
];

/** A fresh copy of the seed list — never hand out the shared array, or one
 *  account's edits would leak into every other config built in this process. */
export function seededSmsInfoItems(): SmsInfoItem[] {
  return SEEDED_SMS_INFO_ITEMS.map((i) => ({ ...i }));
}

const PLACEHOLDER_RE = /\{\{\s*(\w+)\s*\}\}/g;

/** Links / emails must never be truncated mid-way — half a URL is useless. */
const PROTECTED_RE = /(?:https?:\/\/|www\.)\S+|[^\s@]+@[^\s@]+\.[^\s@]+/i;

const collapse = (text: string): string => text.replace(/\s+/g, " ").trim();

/** The placeholders a template actually references, minus the decorative ones. */
export function requiredPlaceholders(template: string): (keyof SmsInfoValues)[] {
  const keys = new Set<string>();
  for (const m of template.matchAll(PLACEHOLDER_RE)) {
    if (!OPTIONAL_PLACEHOLDERS.has(m[1])) keys.add(m[1]);
  }
  return [...keys].filter((k): k is keyof SmsInfoValues => k in EMPTY_SMS_INFO_VALUES);
}

/** Substitute {{placeholders}} with the business's real details. A function
 *  replacer keeps a `$` inside a value from being read as a replacement token. */
export function renderSmsTemplate(template: string, values: SmsInfoValues): string {
  return template.replace(PLACEHOLDER_RE, (_match, key: string) => {
    const value = values[key as keyof SmsInfoValues];
    return typeof value === "string" ? value.trim() : "";
  });
}

/** Clean up what a blank optional placeholder leaves behind — a dangling space
 *  before a full stop, a doubled comma, a sentence starting with punctuation. */
function tidy(text: string): string {
  return collapse(text)
    .replace(/\s+([.,!?;:])/g, "$1")
    .replace(/([.,!?;:])\1+/g, "$1")
    .replace(/^[\s.,!?;:—-]+/, "")
    .trim();
}

/** Trim to at most `max` chars on a whole-word boundary, dropping any dangling
 *  punctuation. Mirrors clipToWord in server/src/services/sms.ts. */
function clipToWord(text: string, max: number): string {
  const t = collapse(text);
  if (max <= 0) return "";
  if (t.length <= max) return t;
  const clipped = t.slice(0, max);
  const lastSpace = clipped.lastIndexOf(" ");
  return (lastSpace > 0 ? clipped.slice(0, lastSpace) : clipped).replace(/[\s,.;:]+$/, "");
}

/** Fit under `limit` without mangling the link/email. Drop non-essential sentences from the END first,
 *  then clip on a word boundary (can't split a URL); if the clip would lose the link, send the link alone. */
export function clampSms(text: string, limit = SMS_MAX_LENGTH): string {
  const full = collapse(text);
  if (full.length <= limit) return full;

  const parts = full.split(/(?<=[.!?])\s+/).filter(Boolean);
  const essential = parts.map((p) => PROTECTED_RE.test(p));
  const keep = parts.map(() => true);
  const joined = () => collapse(parts.filter((_, i) => keep[i]).join(" "));
  for (let i = parts.length - 1; i >= 0; i--) {
    if (joined().length <= limit) break;
    // Never strip the message down to nothing — a single over-long sentence has
    // to survive to the word clip below, not vanish.
    if (!essential[i] && keep.filter(Boolean).length > 1) keep[i] = false;
  }

  const kept = joined();
  if (kept.length <= limit) return kept;

  const clipped = clipToWord(kept, limit);
  if (PROTECTED_RE.test(kept) && !PROTECTED_RE.test(clipped)) {
    const token = kept.match(PROTECTED_RE)?.[0] ?? "";
    return token.slice(0, limit);
  }
  return clipped;
}

/** The exact message this item would text, or "" when a required detail is blank. Always within SMS_MAX_LENGTH. */
export function buildSmsInfoBody(item: SmsInfoItem, values: SmsInfoValues): string {
  const template = item.template?.trim();
  if (!template) return "";
  if (requiredPlaceholders(template).some((k) => !values[k]?.trim())) return "";
  return clampSms(tidy(renderSmsTemplate(template, values)));
}

/** Compact form for a combined SMS: a single-detail template collapses to "Label: value" so the greeting
 *  isn't repeated per item; free-text custom items stay whole. "" when a required detail is missing. */
export function smsInfoFragment(item: SmsInfoItem, values: SmsInfoValues): string {
  const template = item.template?.trim();
  if (!template) return "";
  const required = requiredPlaceholders(template);
  if (required.some((k) => !values[k]?.trim())) return "";
  if (required.length === 1) {
    const label = item.label?.trim() || required[0];
    return `${label}: ${values[required[0]].trim()}`;
  }
  return tidy(renderSmsTemplate(template, values));
}

/** ONE text for several requested details — business name once, then compact fragments. Single item
 *  falls back to buildSmsInfoBody; always within SMS_MAX_LENGTH. */
export function buildCombinedSmsBody(
  items: SmsInfoItem[],
  values: SmsInfoValues,
  businessName = "",
): string {
  if (items.length <= 1) return items[0] ? buildSmsInfoBody(items[0], values) : "";
  const fragments = items.map((i) => smsInfoFragment(i, values)).filter(Boolean);
  if (!fragments.length) return "";
  const biz = businessName.trim();
  const body = fragments.join(" · ");
  return clampSms(biz ? `${biz} — ${body}` : body);
}

/** Every item the AI may currently offer: enabled, and with a message that
 *  actually renders. This is the list the tool's `topic` enum is built from. */
export function availableSmsInfoItems(
  items: SmsInfoItem[] | undefined,
  values: SmsInfoValues,
): { item: SmsInfoItem; body: string }[] {
  const seen = new Set<string>();
  const out: { item: SmsInfoItem; body: string }[] = [];
  for (const item of items ?? []) {
    const key = item.key?.trim();
    // A duplicate key would make the tool enum ambiguous — first one wins.
    if (!item.enabled || !key || seen.has(key)) continue;
    const body = buildSmsInfoBody(item, values);
    if (!body) continue;
    seen.add(key);
    out.push({ item, body });
  }
  return out;
}

/** Coerce stored `smsOnRequest.items` into shape; a pre-feature config (no array) gets the seeded
 *  catalogue. Mirrors normalizeSmsInfoItems in server/src/lib/agentConfig.ts. */
export function normalizeSmsInfoItems(raw: unknown): SmsInfoItem[] {
  if (!Array.isArray(raw)) return seededSmsInfoItems();
  const seen = new Set<string>();
  const items: SmsInfoItem[] = [];
  let enabledCount = 0;
  for (const entry of raw) {
    const r = (entry ?? {}) as Partial<SmsInfoItem>;
    const key = String(r.key ?? "").trim();
    const template = String(r.template ?? "").trim();
    // No key means the AI has no way to ask for it; no template means there's
    // nothing to send. Either way the row is unusable — drop it.
    if (!key || !template || seen.has(key)) continue;
    seen.add(key);
    // Cap enabled rows even for a client bypassing the UI. Extras are paused, not dropped,
    // so the owner doesn't silently lose the detail.
    let enabled = r.enabled !== false;
    if (enabled && enabledCount >= MAX_ENABLED_SMS_INFO_ITEMS) enabled = false;
    if (enabled) enabledCount++;
    items.push({
      id: String(r.id ?? "").trim() || `sms_${key}`,
      key,
      label: String(r.label ?? "").trim() || key,
      enabled,
      whenToUse: String(r.whenToUse ?? "").trim(),
      template,
      ...(r.custom ? { custom: true } : {}),
    });
    // Safety bound on the stored array size.
    if (items.length >= MAX_SMS_INFO_ITEMS) break;
  }
  return items;
}

/** Turn an owner-typed label into a stable, unique enum key ("Parking info" →
 *  "parking_info"). Falls back to a counter when the label has nothing usable. */
export function smsInfoKeyFrom(label: string, taken: Iterable<string>): string {
  const used = new Set(taken);
  const base =
    label
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 32) || "item";
  if (!used.has(base)) return base;
  for (let n = 2; ; n++) {
    const next = `${base}_${n}`;
    if (!used.has(next)) return next;
  }
}
