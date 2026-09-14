import {
  isValidPhoneNumber,
  parsePhoneNumberFromString,
} from "libphonenumber-js/max";

export type Country = {
  /** ISO 3166-1 alpha-2 code, lowercase (also used for the flag image). */
  code: string;
  name: string;
  /** International dialing code without the leading "+". */
  dial: string;
  /** National-number digit range, excluding the dial code. Only caps UI input length —
   *  real validation is libphonenumber (`isValidPhone`). */
  len: [min: number, max: number];
};

/** Curated list of commonly-used countries, ordered by name. */
export const COUNTRIES: Country[] = [
  { code: "us", name: "United States", dial: "1", len: [10, 10] },
  { code: "gb", name: "United Kingdom", dial: "44", len: [9, 10] },
  { code: "ca", name: "Canada", dial: "1", len: [10, 10] },
  { code: "au", name: "Australia", dial: "61", len: [9, 9] },
  { code: "in", name: "India", dial: "91", len: [10, 10] },
  { code: "ae", name: "United Arab Emirates", dial: "971", len: [8, 9] },
  { code: "ar", name: "Argentina", dial: "54", len: [10, 11] },
  { code: "at", name: "Austria", dial: "43", len: [10, 11] },
  { code: "bd", name: "Bangladesh", dial: "880", len: [10, 10] },
  { code: "be", name: "Belgium", dial: "32", len: [8, 9] },
  { code: "br", name: "Brazil", dial: "55", len: [10, 11] },
  { code: "ch", name: "Switzerland", dial: "41", len: [9, 9] },
  { code: "cl", name: "Chile", dial: "56", len: [9, 9] },
  { code: "cn", name: "China", dial: "86", len: [11, 11] },
  { code: "co", name: "Colombia", dial: "57", len: [10, 10] },
  { code: "cz", name: "Czechia", dial: "420", len: [9, 9] },
  { code: "de", name: "Germany", dial: "49", len: [10, 11] },
  { code: "dk", name: "Denmark", dial: "45", len: [8, 8] },
  { code: "eg", name: "Egypt", dial: "20", len: [10, 10] },
  { code: "es", name: "Spain", dial: "34", len: [9, 9] },
  { code: "fi", name: "Finland", dial: "358", len: [6, 12] },
  { code: "fr", name: "France", dial: "33", len: [9, 9] },
  { code: "gr", name: "Greece", dial: "30", len: [10, 10] },
  { code: "hk", name: "Hong Kong", dial: "852", len: [8, 8] },
  { code: "id", name: "Indonesia", dial: "62", len: [9, 12] },
  { code: "ie", name: "Ireland", dial: "353", len: [7, 9] },
  { code: "il", name: "Israel", dial: "972", len: [9, 9] },
  { code: "it", name: "Italy", dial: "39", len: [9, 10] },
  { code: "jp", name: "Japan", dial: "81", len: [9, 10] },
  { code: "ke", name: "Kenya", dial: "254", len: [9, 9] },
  { code: "kr", name: "South Korea", dial: "82", len: [9, 10] },
  { code: "mx", name: "Mexico", dial: "52", len: [10, 10] },
  { code: "my", name: "Malaysia", dial: "60", len: [9, 10] },
  { code: "ng", name: "Nigeria", dial: "234", len: [10, 10] },
  { code: "nl", name: "Netherlands", dial: "31", len: [9, 9] },
  { code: "no", name: "Norway", dial: "47", len: [8, 8] },
  { code: "nz", name: "New Zealand", dial: "64", len: [8, 10] },
  { code: "ph", name: "Philippines", dial: "63", len: [10, 10] },
  { code: "pk", name: "Pakistan", dial: "92", len: [10, 10] },
  { code: "pl", name: "Poland", dial: "48", len: [9, 9] },
  { code: "pt", name: "Portugal", dial: "351", len: [9, 9] },
  { code: "ro", name: "Romania", dial: "40", len: [9, 9] },
  { code: "ru", name: "Russia", dial: "7", len: [10, 10] },
  { code: "sa", name: "Saudi Arabia", dial: "966", len: [9, 9] },
  { code: "se", name: "Sweden", dial: "46", len: [7, 9] },
  { code: "sg", name: "Singapore", dial: "65", len: [8, 8] },
  { code: "th", name: "Thailand", dial: "66", len: [9, 9] },
  { code: "tr", name: "Turkey", dial: "90", len: [10, 10] },
  { code: "ua", name: "Ukraine", dial: "380", len: [9, 9] },
  { code: "vn", name: "Vietnam", dial: "84", len: [9, 10] },
  { code: "za", name: "South Africa", dial: "27", len: [9, 9] },
];

export const DEFAULT_COUNTRY = COUNTRIES[0];

/** Countries the admin can offer to customers for number selection (ISO codes). */
export const ADMIN_COUNTRY_CODES = ["us", "gb", "ca", "au", "nz"] as const;

/** Twilio number-pricing categories — keys returned by `getNumberPricing`. */
export type NumberType = "local" | "mobile" | "national" | "tollFree";

export type NumberPrefix = {
  value: string;
  label: string;
  /** Maps the prefix to a Twilio number-type so its live price can be looked up. */
  type: NumberType;
};

/** Per-country prefixes for narrowing a Twilio number search. NANP (US/CA) searches by area code,
 *  so their "prefix" is a 3-digit area code, all priced as local. */
export const NUMBER_PREFIXES: Record<string, NumberPrefix[]> = {
  au: [
    { value: "02", label: "02 — Sydney (NSW/ACT)", type: "local" },
    { value: "03", label: "03 — Melbourne (VIC/TAS)", type: "local" },
    { value: "04", label: "04 — Mobile", type: "mobile" },
    { value: "07", label: "07 — Brisbane (QLD)", type: "local" },
    { value: "08", label: "08 — Perth/Adelaide (WA/SA/NT)", type: "local" },
  ],
  nz: [
    { value: "03", label: "03 — South Island", type: "local" },
    { value: "04", label: "04 — Wellington", type: "local" },
    { value: "06", label: "06 — Lower North Island", type: "local" },
    { value: "07", label: "07 — Waikato / BOP", type: "local" },
    { value: "09", label: "09 — Auckland", type: "local" },
    { value: "02", label: "02 — Mobile", type: "mobile" },
  ],
  gb: [
    { value: "01", label: "01 — Landline (geographic)", type: "local" },
    { value: "02", label: "02 — Landline (geographic)", type: "local" },
    { value: "03", label: "03 — Non-geographic", type: "national" },
    { value: "07", label: "07 — Mobile", type: "mobile" },
    { value: "08", label: "08 — Freephone / business", type: "tollFree" },
  ],
  // NANP — "prefix" means a 3-digit area code; this is a curated popular set
  // (Twilio is searched by area code for these countries).
  us: [
    { value: "212", label: "212 — New York", type: "local" },
    { value: "415", label: "415 — San Francisco", type: "local" },
    { value: "310", label: "310 — Los Angeles", type: "local" },
    { value: "312", label: "312 — Chicago", type: "local" },
    { value: "305", label: "305 — Miami", type: "local" },
    { value: "202", label: "202 — Washington DC", type: "local" },
    { value: "702", label: "702 — Las Vegas", type: "local" },
    { value: "617", label: "617 — Boston", type: "local" },
    { value: "214", label: "214 — Dallas", type: "local" },
    { value: "206", label: "206 — Seattle", type: "local" },
  ],
  ca: [
    { value: "416", label: "416 — Toronto", type: "local" },
    { value: "604", label: "604 — Vancouver", type: "local" },
    { value: "514", label: "514 — Montreal", type: "local" },
    { value: "403", label: "403 — Calgary", type: "local" },
    { value: "613", label: "613 — Ottawa", type: "local" },
    { value: "780", label: "780 — Edmonton", type: "local" },
  ],
};

/** Live Twilio number pricing for a country (from `GET /api/profile/number-pricing`). */
export type NumberPricing = { currency: string; prices: Partial<Record<NumberType, number>> };

/** Format a monthly number price, e.g. "$6.00/mo" or "5.00 AUD/mo". */
export function formatNumberPrice(currency: string, amount: number): string {
  const cur = (currency || "USD").toUpperCase();
  const v = amount.toFixed(2);
  return cur === "USD" ? `$${v}/mo` : `${v} ${cur}/mo`;
}

/** Flag image URL for a country code (SVG, served by flagcdn). */
export const flagUrl = (code: string) => `https://flagcdn.com/${code}.svg`;

/** Country for a stored E.164-ish value, by longest dial-code prefix; falls back to the default. */
export function countryFromValue(value: string): Country {
  if (!value.startsWith("+")) return DEFAULT_COUNTRY;
  const digits = value.slice(1);
  let best = DEFAULT_COUNTRY;
  let bestLen = 0;
  for (const c of COUNTRIES) {
    if (digits.startsWith(c.dial) && c.dial.length > bestLen) {
      best = c;
      bestLen = c.dial.length;
    }
  }
  return best;
}

const byCode = (code: string): Country | undefined =>
  COUNTRIES.find((c) => c.code === code.toLowerCase());

// Timezone → ISO for markets where browser language often disagrees with physical region
// (an "en-US" locale used from India or the Gulf). Checked before the locale so location wins.
const TZ_TO_ISO: Record<string, string> = {
  "Asia/Kolkata": "in", "Asia/Calcutta": "in",
  "Asia/Karachi": "pk", "Asia/Dhaka": "bd",
  "Asia/Dubai": "ae", "Asia/Singapore": "sg", "Asia/Hong_Kong": "hk",
  "Asia/Manila": "ph", "Asia/Jakarta": "id", "Asia/Kuala_Lumpur": "my",
  "Asia/Tokyo": "jp", "Asia/Seoul": "kr", "Asia/Shanghai": "cn",
  "Pacific/Auckland": "nz",
  "Europe/London": "gb",
  "Australia/Sydney": "au", "Australia/Melbourne": "au", "Australia/Brisbane": "au",
  "Australia/Perth": "au", "Australia/Adelaide": "au", "Australia/Hobart": "au",
  "Australia/Darwin": "au",
  "America/Toronto": "ca", "America/Vancouver": "ca", "America/Edmonton": "ca",
  "America/Winnipeg": "ca", "America/Halifax": "ca",
};

/** Guess the visitor's country for the dial-code default: timezone first, then the locale's region
 *  subtag, then DEFAULT_COUNTRY. Only returns a country we list. */
export function guessCountry(): Country {
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const iso = tz ? TZ_TO_ISO[tz] : undefined;
    const hit = iso ? byCode(iso) : undefined;
    if (hit) return hit;
  } catch {
    /* Intl/timezone unavailable — fall through to locale. */
  }
  try {
    const langs =
      typeof navigator !== "undefined"
        ? navigator.languages?.length
          ? navigator.languages
          : [navigator.language]
        : [];
    for (const l of langs) {
      const region = l ? new Intl.Locale(l).region : undefined;
      const hit = region ? byCode(region) : undefined;
      if (hit) return hit;
    }
  } catch {
    /* Intl.Locale unavailable — fall through to default. */
  }
  return DEFAULT_COUNTRY;
}

/** National-number digits for a stored value, given its country. */
export function nationalNumber(value: string, country: Country): string {
  const prefix = `+${country.dial}`;
  const rest = value.startsWith(prefix) ? value.slice(prefix.length) : value.replace(/^\+/, "");
  return rest.replace(/\D/g, "");
}

/** Digits-only + length cap, WITHOUT stripping a typed leading "0" (stripping made the cursor jump and
 *  digits vanish mid-typing). A leading "0" gets one extra digit of room; `toE164` drops it later. */
export function nationalDigits(country: Country, raw: string): string {
  const digits = raw.replace(/\D/g, "");
  const cap = digits.startsWith("0") ? country.len[1] + 1 : country.len[1];
  return digits.slice(0, cap);
}

/** Validate an E.164 value with libphonenumber's per-country rules — rejects what a length check
 *  accepts, e.g. an Indian number with a leading "0" or not starting 6–9. */
export function isValidPhone(value: string): boolean {
  if (!value?.trim()) return false;
  const e164 = value.startsWith("+") ? value : `+${value}`;
  if (!isValidPhoneNumber(e164)) return false;
  // `isValidPhoneNumber` silently strips a trunk "0" and passes "+9109876543210" — so also
  // require canonical E.164. Italy's legitimate leading "0" survives parsing and still passes.
  const parsed = parsePhoneNumberFromString(e164);
  return parsed?.number === e164;
}

/** Validation message, or null when valid or blank (callers handle "required"). A number that's
 *  only wrong because of a trunk "0" (India/UK) gets a targeted hint instead of the generic one. */
export function phoneError(value: string): string | null {
  if (!value?.trim()) return null;
  if (isValidPhone(value)) return null;
  const country = countryFromValue(value);
  const nat = nationalNumber(value, country);
  if (nat.startsWith("0") && isValidPhone(`+${country.dial}${nat.replace(/^0+/, "")}`)) {
    return "Remove the leading 0 — enter the number in international format (without the trunk code).";
  }
  return "Enter a valid phone number for the selected country.";
}

/** `phoneError` plus a mobile requirement for SMS/WhatsApp. Rejects a definite landline/non-mobile
 *  type; ambiguous or unknown types pass to avoid false negatives. */
export function mobileError(value: string): string | null {
  const generic = phoneError(value);
  if (generic) return generic;
  if (!value?.trim()) return null;
  const e164 = value.startsWith("+") ? value : `+${value}`;
  const type = parsePhoneNumberFromString(e164)?.getType();
  if (type && type !== "MOBILE" && type !== "FIXED_LINE_OR_MOBILE") {
    return "Enter a mobile number — SMS/WhatsApp can't be delivered to a landline.";
  }
  return null;
}

/** Canonical E.164 from country + typed digits. Drops a trunk "0" only when that makes the number
 *  valid (keeps Italy's real leading 0); incomplete input stays as typed so `phoneError` can hint. */
export function toE164(country: Country, digits: string): string {
  const d = digits.replace(/\D/g, "");
  if (!d) return "";
  const withZero = `+${country.dial}${d}`;
  if (d.startsWith("0")) {
    const stripped = d.replace(/^0+/, "");
    const withoutZero = `+${country.dial}${stripped}`;
    if (stripped && isValidPhone(withoutZero) && !isValidPhone(withZero)) return withoutZero;
  }
  return withZero;
}
