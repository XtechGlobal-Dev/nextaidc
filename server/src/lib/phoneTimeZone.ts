import { parsePhoneNumberFromString } from "libphonenumber-js/max";

// Fallback when nothing derives a zone. Always show the zone label with the time so a fallback
// is never mistaken for a precise local reading.
const DEFAULT_TIME_ZONE = process.env.DEFAULT_TIMEZONE || "Asia/Kolkata";

// Country → representative IANA zone. Multi-timezone countries get their most populous zone.
const COUNTRY_TIME_ZONE: Record<string, string> = {
  IN: "Asia/Kolkata",
  PK: "Asia/Karachi",
  BD: "Asia/Dhaka",
  LK: "Asia/Colombo",
  NP: "Asia/Kathmandu",
  AE: "Asia/Dubai",
  SA: "Asia/Riyadh",
  QA: "Asia/Qatar",
  KW: "Asia/Kuwait",
  BH: "Asia/Bahrain",
  OM: "Asia/Muscat",
  SG: "Asia/Singapore",
  MY: "Asia/Kuala_Lumpur",
  ID: "Asia/Jakarta",
  TH: "Asia/Bangkok",
  PH: "Asia/Manila",
  VN: "Asia/Ho_Chi_Minh",
  HK: "Asia/Hong_Kong",
  CN: "Asia/Shanghai",
  JP: "Asia/Tokyo",
  KR: "Asia/Seoul",
  GB: "Europe/London",
  IE: "Europe/Dublin",
  FR: "Europe/Paris",
  DE: "Europe/Berlin",
  ES: "Europe/Madrid",
  IT: "Europe/Rome",
  NL: "Europe/Amsterdam",
  BE: "Europe/Brussels",
  CH: "Europe/Zurich",
  SE: "Europe/Stockholm",
  NO: "Europe/Oslo",
  DK: "Europe/Copenhagen",
  FI: "Europe/Helsinki",
  PL: "Europe/Warsaw",
  PT: "Europe/Lisbon",
  GR: "Europe/Athens",
  TR: "Europe/Istanbul",
  ZA: "Africa/Johannesburg",
  NG: "Africa/Lagos",
  KE: "Africa/Nairobi",
  EG: "Africa/Cairo",
  IL: "Asia/Jerusalem",
  // Multi-timezone countries — most populous zone as a best-effort default.
  US: "America/New_York",
  CA: "America/Toronto",
  BR: "America/Sao_Paulo",
  MX: "America/Mexico_City",
  AR: "America/Argentina/Buenos_Aires",
  AU: "Australia/Sydney",
  NZ: "Pacific/Auckland",
  RU: "Europe/Moscow",
};

// Only multi-timezone countries need an entry. A browser zone is trusted only when it agrees
// with the country the business's number/address is in.
const COUNTRY_ZONES: Record<string, string[]> = {
  AU: [
    "Australia/Sydney", "Australia/Melbourne", "Australia/Brisbane", "Australia/Adelaide",
    "Australia/Perth", "Australia/Darwin", "Australia/Hobart", "Australia/Canberra",
    "Australia/Broken_Hill", "Australia/Lindeman", "Australia/Lord_Howe", "Australia/Eucla",
  ],
  US: [
    "America/New_York", "America/Chicago", "America/Denver", "America/Phoenix",
    "America/Los_Angeles", "America/Anchorage", "America/Juneau", "America/Detroit",
    "America/Indiana/Indianapolis", "America/Kentucky/Louisville", "America/Boise", "Pacific/Honolulu",
  ],
  CA: [
    "America/Toronto", "America/Vancouver", "America/Edmonton", "America/Winnipeg",
    "America/Halifax", "America/St_Johns", "America/Regina", "America/Whitehorse",
  ],
  BR: ["America/Sao_Paulo", "America/Manaus", "America/Fortaleza", "America/Recife", "America/Bahia"],
  MX: ["America/Mexico_City", "America/Tijuana", "America/Monterrey", "America/Cancun", "America/Chihuahua"],
  RU: ["Europe/Moscow", "Europe/Kaliningrad", "Asia/Yekaterinburg", "Asia/Novosibirsk", "Asia/Vladivostok"],
  ID: ["Asia/Jakarta", "Asia/Makassar", "Asia/Jayapura"],
  NZ: ["Pacific/Auckland", "Pacific/Chatham"],
};

/** True when `zone` is plausible for a business in `country` (ISO alpha-2). */
export function zoneMatchesCountry(zone: string, country: string): boolean {
  const iso = country.toUpperCase();
  const zones = COUNTRY_ZONES[iso] ?? [COUNTRY_TIME_ZONE[iso]].filter(Boolean);
  return zones.includes(zone);
}

// Old configs stored a display label instead of an IANA zone; translate on read, no migration.
const LEGACY_LABEL_TO_IANA: Record<string, string> = {
  "Sydney (AEST/AEDT)": "Australia/Sydney",
  "Melbourne (AEST/AEDT)": "Australia/Melbourne",
  "Brisbane (AEST)": "Australia/Brisbane",
  "Adelaide (ACST/ACDT)": "Australia/Adelaide",
  "Perth (AWST)": "Australia/Perth",
  "Darwin (ACST)": "Australia/Darwin",
  "Hobart (AEST/AEDT)": "Australia/Hobart",
};

// Old IANA aliases → modern zone. Keep in step with src/lib/timezone.ts, or a stored alias the
// picker doesn't know leaves the owner's field blank.
const ALIAS_TO_CANONICAL: Record<string, string> = {
  "Asia/Calcutta": "Asia/Kolkata",
  "Asia/Saigon": "Asia/Ho_Chi_Minh",
  "Asia/Rangoon": "Asia/Yangon",
  "Asia/Katmandu": "Asia/Kathmandu",
  "Australia/Canberra": "Australia/Sydney",
  "Australia/NSW": "Australia/Sydney",
  "Australia/Victoria": "Australia/Melbourne",
  "Australia/Queensland": "Australia/Brisbane",
  "Australia/South": "Australia/Adelaide",
  "Australia/West": "Australia/Perth",
  "Australia/North": "Australia/Darwin",
  "Australia/Tasmania": "Australia/Hobart",
  "America/Buenos_Aires": "America/Argentina/Buenos_Aires",
  "Europe/Kiev": "Europe/Kyiv",
  "Asia/Istanbul": "Europe/Istanbul",
  "US/Eastern": "America/New_York",
  "US/Central": "America/Chicago",
  "US/Mountain": "America/Denver",
  "US/Pacific": "America/Los_Angeles",
  "US/Hawaii": "Pacific/Honolulu",
  "Canada/Eastern": "America/Toronto",
  "Canada/Pacific": "America/Vancouver",
  "Europe/Belfast": "Europe/London",
  GB: "Europe/London",
  "GB-Eire": "Europe/London",
  Eire: "Europe/Dublin",
};

/** The modern spelling of a zone, so what we store matches what the dashboard
 *  picker offers. Unmapped zones pass through — they're already current. */
export function canonicalTimeZone(tz: string): string {
  const raw = tz.trim();
  return ALIAS_TO_CANONICAL[raw] ?? raw;
}

/** Coerce a stored timezone to a canonical IANA zone; "" when uninterpretable so callers fall back. */
export function normalizeTimeZone(value?: string): string {
  const raw = value?.trim();
  if (!raw) return "";
  if (LEGACY_LABEL_TO_IANA[raw]) return LEGACY_LABEL_TO_IANA[raw];
  return isValidTimeZone(raw) ? canonicalTimeZone(raw) : "";
}

/** Human label for a zone, e.g. "Perth (AWST)" — city plus the abbreviation in
 *  effect right now, so it stays honest across DST. */
export function timeZoneLabel(tz: string, now: Date = new Date()): string {
  if (!isValidTimeZone(tz)) return tz;
  const city = (tz.split("/").pop() ?? tz).replace(/_/g, " ");
  const abbr = new Intl.DateTimeFormat("en-US", { timeZone: tz, timeZoneName: "short" })
    .formatToParts(now)
    .find((p) => p.type === "timeZoneName")?.value;
  return abbr ? `${city} (${abbr})` : city;
}

// Address → zone, Australia only: offshore signups are routine there, so the browser zone can't
// settle Sydney vs Perth. Postcode is most reliable, then state code, then city. US/CA not implemented.
const AU_STATE_ZONE: Record<string, string> = {
  NSW: "Australia/Sydney",
  ACT: "Australia/Sydney", // Canberra shares Sydney's zone
  VIC: "Australia/Melbourne",
  QLD: "Australia/Brisbane",
  SA: "Australia/Adelaide",
  WA: "Australia/Perth",
  TAS: "Australia/Hobart",
  NT: "Australia/Darwin",
};

/** AU state for a 4-digit postcode, or "" if it's not in any state's range. */
function auStateFromPostcode(pc: number): string {
  if ((pc >= 1000 && pc <= 2599) || (pc >= 2619 && pc <= 2899) || (pc >= 2921 && pc <= 2999)) return "NSW";
  if ((pc >= 200 && pc <= 299) || (pc >= 2600 && pc <= 2618) || (pc >= 2900 && pc <= 2920)) return "ACT";
  if ((pc >= 3000 && pc <= 3999) || (pc >= 8000 && pc <= 8999)) return "VIC";
  if ((pc >= 4000 && pc <= 4999) || (pc >= 9000 && pc <= 9999)) return "QLD";
  if (pc >= 5000 && pc <= 5799) return "SA";
  if (pc >= 6000 && pc <= 6797) return "WA";
  if (pc >= 7000 && pc <= 7799) return "TAS";
  if ((pc >= 800 && pc <= 899) || (pc >= 900 && pc <= 999)) return "NT";
  return "";
}

const AU_CITY_ZONE: Array<[RegExp, string]> = [
  [/\b(melbourne|geelong|ballarat|bendigo|glen waverley|dandenong|frankston)\b/i, "Australia/Melbourne"],
  [/\b(sydney|newcastle|wollongong|parramatta)\b/i, "Australia/Sydney"],
  [/\b(canberra)\b/i, "Australia/Sydney"],
  [/\b(brisbane|gold coast|cairns|townsville|sunshine coast|toowoomba)\b/i, "Australia/Brisbane"],
  [/\b(perth|fremantle|mandurah)\b/i, "Australia/Perth"],
  [/\badelaide\b/i, "Australia/Adelaide"],
  [/\bdarwin\b/i, "Australia/Darwin"],
  [/\b(hobart|launceston)\b/i, "Australia/Hobart"],
];

/** Best-effort AU zone from a free-text address; "" when nothing matches. */
function auZoneFromAddress(address: string): string {
  const postcodes = address.match(/\b\d{4}\b/g);
  if (postcodes) {
    // Postcode sits at the end of an AU address; scan from the last match.
    for (let i = postcodes.length - 1; i >= 0; i--) {
      const state = auStateFromPostcode(Number(postcodes[i]));
      if (state) return AU_STATE_ZONE[state];
    }
  }
  const stateCode = address.match(/\b(NSW|ACT|VIC|QLD|SA|WA|TAS|NT)\b/);
  if (stateCode) return AU_STATE_ZONE[stateCode[1]];
  for (const [re, zone] of AU_CITY_ZONE) if (re.test(address)) return zone;
  return "";
}

/** Confidently Australian? WA/SA/NT collide with US states and common words, so they only count
 *  alongside a matching AU postcode. */
function looksAustralian(address: string): boolean {
  if (/\baustralia\b/i.test(address)) return true;
  if (/\b(NSW|ACT|VIC|QLD|TAS)\b/.test(address)) return true;
  const ambiguous = address.match(/\b(WA|SA|NT)\b/);
  if (ambiguous) {
    for (const pc of address.match(/\b\d{4}\b/g) ?? []) {
      if (auStateFromPostcode(Number(pc)) === ambiguous[1]) return true;
    }
  }
  return false;
}

/** Best-effort ISO 3166-1 alpha-2 country from a free-text address. Recognises
 *  Australia only (our market with the multi-timezone problem); "" otherwise. */
export function isoCountryFromAddress(address?: string): string {
  const raw = address?.trim();
  if (!raw) return "";
  return looksAustralian(raw) ? "AU" : "";
}

/** Zone from an address. With country unknown, the address must independently look Australian so a
 *  stray 4-digit street number isn't read as a postcode. Non-AU returns "". */
export function timeZoneFromAddress(address?: string, country?: string): string {
  const raw = address?.trim();
  if (!raw) return "";
  const iso = country?.toUpperCase();
  if (iso === "AU") return auZoneFromAddress(raw);
  if (!iso && looksAustralian(raw)) return auZoneFromAddress(raw);
  return "";
}

/** Country: receptionist number > business number > mobile (owners often sign up on an overseas phone) > address.
 *  City: address > browser zone (only if it matches the country) > default. Surface for confirmation, don't apply silently. */
export function resolveBusinessTimeZone(opts: {
  receptionistNumber?: string;
  businessNumber?: string;
  mobile?: string;
  address?: string;
  browserTimeZone?: string;
  /** A brand's default zone. Last resort only — number, address and browser still win. */
  fallbackTimeZone?: string;
}): string {
  const fallback = isValidTimeZone(opts.fallbackTimeZone)
    ? canonicalTimeZone(opts.fallbackTimeZone!)
    : DEFAULT_TIME_ZONE;
  const browser = isValidTimeZone(opts.browserTimeZone)
    ? canonicalTimeZone(opts.browserTimeZone!)
    : "";
  const country =
    isoCountryForPhone(opts.receptionistNumber) ||
    isoCountryForPhone(opts.businessNumber) ||
    isoCountryForPhone(opts.mobile) ||
    isoCountryFromAddress(opts.address);

  if (country) {
    const fromAddress = timeZoneFromAddress(opts.address, country);
    if (fromAddress) return fromAddress;
    if (browser && zoneMatchesCountry(browser, country)) return browser;
    return COUNTRY_TIME_ZONE[country] || fallback;
  }
  if (browser) return browser;
  return fallback;
}

/** Zone from an E.164 number, or the home zone. Always render the zone label so a fallback is visible. */
export function timeZoneForPhone(mobile?: string): string {
  const raw = mobile?.trim();
  if (!raw) return DEFAULT_TIME_ZONE;
  const country = parsePhoneNumberFromString(raw)?.country;
  return (country && COUNTRY_TIME_ZONE[country]) || DEFAULT_TIME_ZONE;
}

/** Uppercase ISO alpha-2 country for an E.164 number, or "" when missing/invalid. */
export function isoCountryForPhone(number?: string): string {
  const raw = number?.trim();
  if (!raw) return "";
  return parsePhoneNumberFromString(raw)?.country ?? "";
}

/** True if `tz` is a valid IANA timezone the runtime can format with. */
export function isValidTimeZone(tz?: string): boolean {
  if (!tz?.trim()) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz.trim() });
    return true;
  } catch {
    return false;
  }
}

/** Format a moment in the customer's zone (browser-reported, else from their number). Label always included. */
export function formatSignupTime(date: Date, opts: { timezone?: string; mobile?: string }): string {
  const timeZone = isValidTimeZone(opts.timezone) ? opts.timezone!.trim() : timeZoneForPhone(opts.mobile);
  return date.toLocaleString("en-GB", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZone,
    timeZoneName: "short",
  });
}
