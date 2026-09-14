import twilio from "twilio";
import type { Twilio } from "twilio";
import { parsePhoneNumberFromString } from "libphonenumber-js";
import { notImplemented } from "../lib/http.js";
import { env } from "../env.js";
import { prisma } from "../prisma.js";
import { getEffective, integrationConfiguredFor } from "./settings.js";
import { traceCall } from "./apiTrace.js";
import { currentBrandId } from "../lib/brandContext.js";
import { brandIdForUser } from "./brands.js";

// One client per Twilio account — a single cached client would send (and bill) a
// white-label brand's texts through the platform's account.
const clients = new Map<string, Twilio>();

function sms(brandId?: string | null): Twilio {
  const sid = getEffective("twilio.accountSid", brandId).trim();
  const token = getEffective("twilio.authToken", brandId).trim();
  if (!sid || !token) {
    throw notImplemented("SMS is not configured (add Twilio credentials in Admin → Settings)");
  }
  // Twilio's SDK throws a raw "accountSid must start with AC" if the SID is wrong —
  // catch it here with a clear, actionable message instead.
  if (!sid.startsWith("AC")) {
    throw notImplemented("Twilio Account SID looks invalid (it must start with AC). Check Admin → Settings → Twilio.");
  }
  const sig = `${sid}:${token}`;
  let existing = clients.get(sig);
  if (!existing) {
    existing = twilio(sid, token);
    if (clients.size > 16) clients.clear();
    clients.set(sig, existing);
  }
  return existing;
}

export async function sendSms(
  to: string,
  body: string,
  from?: string,
  /** Send through this brand's Twilio account. Defaults to the request's
   *  ambient brand; pass explicitly from background work. */
  brandId?: string | null,
) {
  const tenant = brandId !== undefined ? brandId : currentBrandId();
  // Twilio bills per 160-character segment (70 for unicode); this is the
  // conservative GSM-7 count, which is what the vast majority of these are.
  const segments = Math.max(1, Math.ceil(body.length / 160));
  await traceCall(
    "twilio",
    "/Messages",
    () =>
      sms(tenant).messages.create({
        from: from?.trim() || getEffective("twilio.fromNumber", tenant),
        to,
        body,
      }),
    { units: segments },
  );
}

/** Sender for a caller-facing text: the business's own AI number when it's confirmed smsCapable (most aren't — non-NANP geo numbers are voice-only, US local needs 10DLC), else the platform/brand sender. */
export async function resolveSmsSender(userId: string | null | undefined): Promise<string> {
  // Fallback is the OWNER's brand sender, so a white-label customer's text never comes from the platform.
  if (!userId) return getEffective("twilio.fromNumber", currentBrandId());
  try {
    const [own, brandId] = await Promise.all([
      prisma.phoneNumber.findFirst({
        where: { userId, smsCapable: true, status: "active" },
        select: { number: true },
      }),
      brandIdForUser(userId),
    ]);
    return own?.number?.trim() || getEffective("twilio.fromNumber", brandId);
  } catch {
    return getEffective("twilio.fromNumber", currentBrandId());
  }
}

/** Texts a caller one business detail. `body` is owner-template output, never model output; re-clamped to one segment here because extra segments cost money. Returns false instead of throwing. */
export async function textCallerInfo(
  to: string,
  body: string,
  ownerId?: string | null,
): Promise<boolean> {
  const dest = to.trim();
  const message = clipToWord(body, SMS_LIMIT);
  const brandId = currentBrandId();
  if (!dest || !message || !isTwilioConfigured(brandId)) return false;
  try {
    await sendSms(dest, message, await resolveSmsSender(ownerId));
    return true;
  } catch (e) {
    console.warn(`[infoSms] send failed to ${dest}:`, describeSmsError(e));
    return false;
  }
}

/** Build the professional booking-confirmation SMS. Includes WHAT was booked
 *  (the reason, e.g. "haircut", "room booking") and the business name when known. */
export function buildBookingConfirmationSms(
  whenLabel: string,
  opts: { reason?: string; businessName?: string } = {},
): string {
  const subject = (opts.reason ?? "").trim() || "appointment";
  const biz = (opts.businessName ?? "").trim();
  const team = biz ? `Our team at ${biz} will` : "Our team will";
  return `Your ${subject} is confirmed for ${whenLabel}. ${team} be in touch shortly to look after you. Thank you for choosing us!`;
}

/** Texts a booking confirmation. `whenLabel` is already in the owner's timezone. Best-effort. */
export async function textBookingConfirmation(
  to: string,
  whenLabel: string,
  opts: { reason?: string; businessName?: string } = {},
): Promise<boolean> {
  const dest = to.trim();
  if (!dest || !isTwilioConfigured(currentBrandId())) return false;
  try {
    await sendSms(dest, buildBookingConfirmationSms(whenLabel, opts));
    return true;
  } catch (e) {
    console.warn(`[booking] confirmation SMS failed to ${dest}:`, describeSmsError(e));
    return false;
  }
}

export interface CallSummaryOpts {
  callerName: string;
  callerNumber?: string;
  summary?: string;
  /** Short caller purpose/category (few words). Falls back to `summary`. */
  purpose?: string;
  businessName?: string;
  durationSec?: number;
  /** Public "More info" conversation link. When set it's added as its own line
   *  and reserved first, so it's never truncated. */
  conversationUrl?: string;
}

const SMS_LIMIT = 160;

// Whole-word clip with dangling punctuation dropped; "" when not even one word fits.
function clipToWord(text: string, max: number): string {
  const t = text.replace(/\s+/g, " ").trim();
  if (max <= 0) return "";
  if (t.length <= max) return t;
  const clipped = t.slice(0, max);
  const lastSpace = clipped.lastIndexOf(" ");
  return (lastSpace > 0 ? clipped.slice(0, lastSpace) : clipped).replace(/[\s,.;:]+$/, "");
}

/** Post-call summary SMS in one 160-char segment: Caller / Purpose / More info. The link is reserved first and never truncated; purpose takes what's left. */
export function buildCallSummarySms(opts: CallSummaryOpts): string {
  const url = opts.conversationUrl?.trim();
  const linkLine = url ? `More info: ${url}` : "";

  // Caller line — cap the name so a very long name can't starve the rest.
  const name = clipToWord(opts.callerName?.trim() || "Unknown caller", 40) || "Unknown caller";
  const num = opts.callerNumber?.trim();
  let callerLine = `Caller: ${name}`;
  if (num && callerLine.length + num.length + 3 <= 60) callerLine += ` (${num})`;

  // Purpose gets whatever's left after the caller + link lines and their newlines.
  const PURPOSE_PREFIX = "Purpose: ";
  const fixed = callerLine.length + (linkLine ? linkLine.length + 1 : 0);
  const purposeSrc = opts.purpose?.trim() || opts.summary?.trim() || "";
  const purposeBudget = SMS_LIMIT - fixed - 1 - PURPOSE_PREFIX.length;
  let purposeLine = "";
  if (purposeSrc && purposeBudget >= 4) {
    const val = clipToWord(purposeSrc, purposeBudget);
    if (val) purposeLine = PURPOSE_PREFIX + val;
  }

  return [callerLine, purposeLine, linkLine].filter(Boolean).join("\n");
}

/** Text a concise post-call summary to the agent owner, from the global SMS
 *  sender number. Best-effort — the caller swallows failures. */
export async function callSummarySms(opts: CallSummaryOpts & { to: string }): Promise<void> {
  await sendSms(opts.to, buildCallSummarySms(opts));
}

/** Turns a Twilio error into an admin-actionable sentence, keyed off Twilio's numeric `code`. */
export function describeSmsError(err: unknown): string {
  const e = err as { code?: number; status?: number; message?: string } | null;
  const code = e?.code;
  const msg = e?.message?.trim();
  switch (code) {
    case 21408:
      return "Twilio hasn't enabled SMS to this destination's region. Enable it in Twilio Console → Messaging → Geo permissions.";
    case 21606:
    case 21212:
      return "The SMS Sender number isn't a valid, SMS-capable Twilio number on this account. Pick a different sender.";
    case 21211:
      return "The recipient number is invalid. Use full E.164 format, e.g. +14155551234.";
    case 21610:
      return "The recipient has unsubscribed (replied STOP) from this sender, so Twilio is blocking the message.";
    case 20003:
      return "Twilio rejected the credentials (authentication failed). Check the Account SID and Auth Token in Admin → Settings.";
  }
  if (msg) return `Twilio error${code ? ` ${code}` : ""}: ${msg}`;
  return "Couldn't send the test message. Check the sender configuration.";
}

export interface NumberPricing {
  currency: string;
  prices: Record<string, number>; // local / mobile / national / tollFree
}

const pricingCache = new Map<string, { data: NumberPricing; expires: number }>();

/** Live Twilio monthly number pricing for a country, keyed by number type. Cached
 *  for 10 min (pricing rarely changes) to avoid hitting Twilio on every request. */
export async function getNumberPricing(country: string): Promise<NumberPricing> {
  const c = (country || "US").toUpperCase().slice(0, 2);
  const cached = pricingCache.get(c);
  if (cached && cached.expires > Date.now()) return cached.data;
  const res = await sms().pricing.v1.phoneNumbers.countries(c).fetch();
  const prices: Record<string, number> = {};
  for (const p of res.phoneNumberPrices ?? []) {
    // numberType: "local" | "mobile" | "national" | "toll free"
    const key = String(p.numberType).toLowerCase().replace(/\s+/g, "");
    const norm = key === "tollfree" ? "tollFree" : key;
    const val = Number(p.currentPrice);
    if (!Number.isNaN(val)) prices[norm] = val;
  }
  const data: NumberPricing = { currency: String(res.priceUnit || "USD").toUpperCase(), prices };
  pricingCache.set(c, { data, expires: Date.now() + 10 * 60 * 1000 });
  return data;
}

// Minimal E.164 dialing-code → ISO country map for pricing lookups. Covers the
// regions we provision in; unknown codes fall back to US pricing.
const DIAL_TO_ISO: Record<string, string> = {
  "1": "US", "44": "GB", "61": "AU", "64": "NZ", "65": "SG",
  "91": "IN", "971": "AE", "353": "IE", "49": "DE", "33": "FR",
};
function isoFromE164(number: string): string {
  const d = number.replace(/[^\d]/g, "");
  for (const len of [3, 2, 1]) {
    const iso = DIAL_TO_ISO[d.slice(0, len)];
    if (iso) return iso;
  }
  return "US";
}

/** Twilio monthly price in cents for a number; null when unavailable so callers can use their own default. */
export async function monthlyPriceCentsFor(number: string): Promise<number | null> {
  try {
    const { prices } = await getNumberPricing(isoFromE164(number));
    const dollars = prices.local ?? prices.national ?? prices.mobile ?? Object.values(prices)[0];
    if (dollars == null || Number.isNaN(dollars)) return null;
    return Math.round(dollars * 100);
  } catch {
    return null;
  }
}

/** Is Twilio usable? No arg = the platform account (the shared number pool). Pass a brand id to ask "can we text THIS tenant's customers" — a brand's own account counts even if the platform has none. A malformed SID counts as unconfigured so we never hit the SDK's raw constructor error. */
export function isTwilioConfigured(brandId?: string | null): boolean {
  return (
    integrationConfiguredFor("twilio", brandId) &&
    getEffective("twilio.accountSid", brandId).trim().startsWith("AC")
  );
}

/** All phone numbers owned by the admin's Twilio account (E.164 strings). */
export async function listTwilioNumbers(): Promise<string[]> {
  const numbers = await sms().incomingPhoneNumbers.list({ limit: 200 });
  return numbers.map((n) => n.phoneNumber);
}

/** Owned numbers with SID and smsCapable — the flag resolveSmsSender gates on. */
export async function listTwilioNumbersDetailed(): Promise<
  { number: string; sid: string; smsCapable: boolean }[]
> {
  const numbers = await sms().incomingPhoneNumbers.list({ limit: 200 });
  return numbers.map((n) => ({
    number: n.phoneNumber,
    sid: n.sid,
    smsCapable: !!n.capabilities?.sms,
  }));
}

/** Whether a number we own can send SMS, per Twilio. Returns null when the
 *  lookup fails, so callers can persist "unknown" rather than a wrong `false`. */
export async function fetchSmsCapability(sid: string): Promise<boolean | null> {
  try {
    const n = await sms().incomingPhoneNumbers(sid).fetch();
    return !!n.capabilities?.sms;
  } catch {
    return null;
  }
}

/** Searches Twilio inventory. `type` picks local vs mobile; not every country has a mobile pool, so callers tolerate an empty/erroring result. */
export async function searchAvailableNumbers(opts: {
  country?: string;
  areaCode?: string;
  contains?: string;
  type?: "local" | "mobile";
  limit?: number;
}): Promise<{ number: string; locality: string; region: string }[]> {
  const country = (opts.country || "US").toUpperCase();
  const areaCode = opts.areaCode && /^\d+$/.test(opts.areaCode) ? Number(opts.areaCode) : undefined;
  const ctx = sms().availablePhoneNumbers(country);
  const params = { areaCode, contains: opts.contains || undefined, limit: opts.limit ?? 20 };
  const list =
    opts.type === "mobile" ? await ctx.mobile.list(params) : await ctx.local.list(params);
  return list.map((n) => ({
    number: n.phoneNumber,
    locality: n.locality ?? "",
    region: n.region ?? "",
  }));
}

// Countries searched by national prefix (AU "03") plus their mobile prefix. NANP
// countries search by area code instead, so they're not here.
const PREFIX_DIAL_CODES: Record<string, string> = { AU: "61", NZ: "64", GB: "44" };
const MOBILE_PREFIX: Record<string, string> = { AU: "04", NZ: "02", GB: "07" };

/** Map a national prefix (e.g. "03","04") for a prefix-country to its Twilio
 *  inventory + E.164 filter (strip the leading 0 onto the country code). */
function prefixToSearch(
  country: string,
  prefix: string,
): { type: "local" | "mobile"; e164: string } | null {
  const dial = PREFIX_DIAL_CODES[country];
  if (!dial) return null;
  const national = prefix.replace(/\D/g, "");
  const area = national.startsWith("0") ? national.slice(1) : national;
  if (!area) return null;
  return { type: national === MOBILE_PREFIX[country] ? "mobile" : "local", e164: `+${dial}${area}` };
}

/** Up to `limit` (max 20) numbers for a prefix. Twilio's `contains` is only a hint, so results are re-filtered on the exact E.164 prefix. */
export async function searchNumbersByPrefix(
  country: string,
  prefix: string,
  limit: number,
): Promise<string[]> {
  const c = (country || "US").toUpperCase();
  const cap = Math.min(Math.max(limit, 1), 20);
  const hint = prefixToSearch(c, prefix);
  if (hint) {
    const primary = await searchAvailableNumbers({
      country: c,
      type: hint.type,
      contains: hint.e164.replace("+", ""),
      limit: 20,
    }).catch(() => []);
    let matches = primary.map((n) => n.number).filter((n) => n.startsWith(hint.e164));
    if (matches.length < cap) {
      const wide = await searchAvailableNumbers({ country: c, type: hint.type, limit: 30 }).catch(
        () => [],
      );
      const more = wide.map((n) => n.number).filter((n) => n.startsWith(hint.e164));
      matches = [...new Set([...matches, ...more])];
    }
    return matches.slice(0, cap);
  }
  const found = await searchAvailableNumbers({
    country: c,
    areaCode: prefix.replace(/\D/g, ""),
    limit: cap,
  }).catch(() => []);
  return found.map((n) => n.number);
}

/** Where the typed digits must sit in the number, mirroring Twilio's "Match to". */
export type NumberMatch = "start" | "anywhere" | "end";

/** Digit search anchored like Twilio's "Match to". Anchoring is done here (Twilio's `contains` is loose), "start" is checked on the NATIONAL number so the dial code never matches, and both inventories are searched or AU mobiles would vanish. */
export async function searchNumbersByPattern(
  country: string,
  digits: string,
  match: NumberMatch,
  limit: number,
  opts: {
    /** Admin-allowed series — a search must never surface a switched-off type. */
    allowedPrefixes?: string[];
    /** Narrow to one series (e.g. AU "03"), combined with the digit match. */
    prefix?: string;
  } = {},
): Promise<string[]> {
  const c = (country || "US").toUpperCase();
  const want = digits.replace(/\D/g, "");
  if (!want) return [];
  const cap = Math.min(Math.max(limit, 1), 20);

  // A prefix pins the inventory; without one query BOTH, or AU mobile searches return nothing.
  const hint = opts.prefix ? prefixToSearch(c, opts.prefix) : null;
  const inventories: ("local" | "mobile")[] = hint ? [hint.type] : ["local", "mobile"];
  const found = await Promise.all(
    inventories.map((type) =>
      searchAvailableNumbers({ country: c, type, contains: want, limit: 20 }).catch(() => []),
    ),
  );

  let matched = found
    .flat()
    .map((n) => n.number)
    .filter((n) => {
      if (match === "end") return n.endsWith(want);
      if (match === "anywhere") return n.includes(want);
      // "start": compare against the national significant number, falling back to
      // the raw digits when the number can't be parsed.
      const national = parsePhoneNumberFromString(n)?.nationalNumber ?? n.replace(/\D/g, "");
      return national.startsWith(want);
    });

  // Series enforced here on the exact E.164 prefix — Twilio's `contains` is only a hint.
  if (hint) matched = matched.filter((n) => n.startsWith(hint.e164));

  // Honour the admin's allowed series, exactly as the prefix + default searches do,
  // so a free-text search can't surface a number type the admin has switched off.
  const e164s = (opts.allowedPrefixes ?? [])
    .map((p) => prefixToSearch(c, p))
    .filter((h): h is { type: "local" | "mobile"; e164: string } => h !== null)
    .map((h) => h.e164);
  const allowed = e164s.length ? matched.filter((n) => e164s.some((p) => n.startsWith(p))) : matched;

  return [...new Set(allowed)].slice(0, cap);
}

/** Default number list for a country. With an allow-list only matching series show; without one, a 3 local + 3 mobile mix topped up to `min`. */
export async function searchDefaultNumbers(
  country: string,
  allowedPrefixes: string[] | undefined,
  min: number,
): Promise<string[]> {
  const c = (country || "US").toUpperCase();
  const show = Math.max(min, 6);

  if (allowedPrefixes && allowedPrefixes.length) {
    const hints = allowedPrefixes
      .map((p) => prefixToSearch(c, p))
      .filter((h): h is { type: "local" | "mobile"; e164: string } => h !== null);
    if (hints.length) {
      // Prefix country (AU/NZ/GB): search only the allowed types, then keep numbers
      // whose E.164 prefix is in the allowed set (so a disallowed series never shows).
      const wantLocal = hints.some((h) => h.type === "local");
      const wantMobile = hints.some((h) => h.type === "mobile");
      const e164s = hints.map((h) => h.e164);
      const [local, mobile] = await Promise.all([
        wantLocal
          ? searchAvailableNumbers({ country: c, type: "local", limit: 20 }).catch(() => [])
          : [],
        wantMobile
          ? searchAvailableNumbers({ country: c, type: "mobile", limit: 20 }).catch(() => [])
          : [],
      ]);
      const matched = [...local, ...mobile]
        .map((n) => n.number)
        .filter((n) => e164s.some((p) => n.startsWith(p)));
      return [...new Set(matched)].slice(0, show);
    }
    // NANP (US/CA): allowed prefixes are area codes — search each in turn.
    const out: string[] = [];
    for (const ac of allowedPrefixes) {
      if (out.length >= show) break;
      const nums = await searchAvailableNumbers({ country: c, areaCode: ac, limit: show }).catch(
        () => [],
      );
      for (const f of nums) if (!out.includes(f.number)) out.push(f.number);
    }
    return out.slice(0, show);
  }

  // No restriction: 3 local + 3 mobile, topped up to `min`.
  const [local, mobile] = await Promise.all([
    searchAvailableNumbers({ country: c, type: "local", limit: 8 }).catch(() => []),
    searchAvailableNumbers({ country: c, type: "mobile", limit: 8 }).catch(() => []),
  ]);
  const localNums = local.map((n) => n.number);
  const mobileNums = mobile.map((n) => n.number);
  const out = [...localNums.slice(0, 3), ...mobileNums.slice(0, 3)];
  for (const n of [...localNums.slice(3), ...mobileNums.slice(3)]) {
    if (out.length >= min) break;
    if (!out.includes(n)) out.push(n);
  }
  return out;
}

/** Buys a number; returns its SID. AU needs an Address + Bundle (env-only), attached only for +61 so other countries' buys aren't rejected; AU mobile may need its own bundle. */
export async function purchaseNumber(number: string): Promise<string> {
  const opts: { phoneNumber: string; addressSid?: string; bundleSid?: string } = {
    phoneNumber: number,
  };
  if (number.startsWith("+61")) {
    const addressSid = env.TWILIO_ADDRESS_SID.trim();
    const isMobile = number.startsWith("+614");
    const bundleSid = ((isMobile && env.TWILIO_BUNDLE_SID_MOBILE.trim()) || env.TWILIO_BUNDLE_SID.trim());
    if (addressSid) opts.addressSid = addressSid;
    if (bundleSid) opts.bundleSid = bundleSid;
  }
  const bought = await sms().incomingPhoneNumbers.create(opts);
  return bought.sid;
}

/** Point a Twilio number's inbound voice webhook at our handler. Best-effort. */
export async function setVoiceWebhook(sid: string, voiceUrl: string): Promise<void> {
  await sms().incomingPhoneNumbers(sid).update({ voiceUrl });
}

/** Hands a number back to Twilio for good — NOT the pool release; irreversible, only for the permanent-removal path. Resolves the SID by number for rows imported before we tracked SIDs. False when already gone. */
export async function releaseTwilioNumber(opts: {
  sid?: string | null;
  number?: string | null;
}): Promise<boolean> {
  let sid = opts.sid?.trim() || "";
  if (!sid) {
    const wanted = (opts.number ?? "").replace(/\s+/g, "");
    if (!wanted) return false;
    const owned = await sms().incomingPhoneNumbers.list({ phoneNumber: wanted, limit: 1 });
    sid = owned[0]?.sid ?? "";
    if (!sid) return false;
  }
  try {
    await sms().incomingPhoneNumbers(sid).remove();
    return true;
  } catch (e) {
    // A 404 means Twilio no longer has it — the end state we were after.
    const status = (e as { status?: number }).status;
    if (status === 404) return false;
    throw e;
  }
}
