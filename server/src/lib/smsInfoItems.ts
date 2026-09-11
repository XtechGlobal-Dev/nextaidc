/* Server-side mirror of src/data/smsInfoItems.ts — the "Text Info to Callers"
 * catalogue and its rendering rules.
 *
 * This copy is the AUTHORITY: it decides what the tool's `topic` enum contains
 * and what actually gets texted. The frontend copy exists only so the template
 * editor can show a live character counter. Keep the two in step — same
 * convention as compilePrompt.ts ↔ agentConfig.ts. Dependency-free by design. */

/** One piece of business information the AI may text a caller on request. */
export interface SmsInfoItem {
  id: string;
  /** Stable key the AI passes as the tool's `topic` (its enum value). */
  key: string;
  label: string;
  enabled: boolean;
  /** Hint that teaches the AI which caller questions this item answers. */
  whenToUse: string;
  /** SMS body. Supports {{business}} {{website}} {{email}} {{address}} {{phone}} {{hours}}. */
  template: string;
  custom?: boolean;
}

/** Hard ceiling on a rendered message: one GSM-7 segment. Enforced before the
 *  send so a message is never split (or billed) as a multi-part SMS. */
export const SMS_MAX_LENGTH = 160;

/** Most details that may be ENABLED at once — seeded and custom together. This is
 *  the user-facing "limit of 3": a small ceiling that keeps the tool's `topic`
 *  enum tight (better model routing), the per-call spend bounded, and the caller's
 *  choices simple. Disabled rows don't count, so a business can keep more than
 *  three drafts around and switch between them. */
export const MAX_ENABLED_SMS_INFO_ITEMS = 3;

/** Hard ceiling on how many rows may exist at all (the three seeded templates plus
 *  up to three custom details). A safety bound on the stored array — the meaningful
 *  limit the owner works against is MAX_ENABLED_SMS_INFO_ITEMS. */
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

/** `business` is decoration — a blank business name tidies away rather than
 *  disabling the item. Every other placeholder IS the thing the caller asked
 *  for, so an item referencing a blank one is hidden instead of texting a gap. */
const OPTIONAL_PLACEHOLDERS = new Set(["business"]);

/**
 * The catalogue every new account starts with — the three most commonly asked-for
 * details. All seeded off: the owner reviews the copy and opts each one in, so a
 * fresh account never texts a caller until it's been set up on purpose. Items
 * whose placeholder has no value on the profile also hide themselves. An owner who
 * wants opening hours or a callback number instead can repurpose any row.
 *
 * Booking links are deliberately absent: the booking module already owns that
 * with its own `sendBookingLink` tool, and two tools that text the same link
 * would just make the model pick badly.
 */
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
 *  punctuation. Mirrors clipToWord in services/sms.ts. */
function clipToWord(text: string, max: number): string {
  const t = collapse(text);
  if (max <= 0) return "";
  if (t.length <= max) return t;
  const clipped = t.slice(0, max);
  const lastSpace = clipped.lastIndexOf(" ");
  return (lastSpace > 0 ? clipped.slice(0, lastSpace) : clipped).replace(/[\s,.;:]+$/, "");
}

/**
 * Force a message under `limit` characters without mangling the detail it
 * exists to deliver.
 *
 * Sentences carrying a link or email address are "essential"; everything else is
 * prose we can spend. Prose is dropped from the END first, so the opener that
 * names the business survives while trailing pleasantries go. Only once nothing
 * optional is left do we clip — on a whole-word boundary, which can never split
 * a URL or email (neither contains a space), and if that clip would cost us the
 * link entirely we send the link on its own instead.
 */
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

/**
 * The exact message this item would text, or "" when it can't be sent — the
 * template references a detail the business hasn't filled in, or renders to
 * nothing. Always within SMS_MAX_LENGTH.
 */
export function buildSmsInfoBody(item: SmsInfoItem, values: SmsInfoValues): string {
  const template = item.template?.trim();
  if (!template) return "";
  if (requiredPlaceholders(template).some((k) => !values[k]?.trim())) return "";
  return clampSms(tidy(renderSmsTemplate(template, values)));
}

/**
 * A compact one-line form of an item, for packing several details into a single
 * combined SMS. A template built around one detail (the website, the email…)
 * collapses to "Label: value" so the greeting isn't repeated for every item; a
 * free-text custom item keeps its whole rendered message. "" when it can't
 * render (a required detail is missing).
 */
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

/**
 * ONE message covering several requested details, so a caller who asks for "the
 * website and the email" gets a single text instead of several. Business name
 * leads once for attribution; each detail follows as a compact fragment. Falls
 * back to the normal single-item message when only one detail is in play, and is
 * always within SMS_MAX_LENGTH (the clamp trims the tail if the caller asked for
 * more than fits, never splitting a link).
 */
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
