import { parsePhoneNumberFromString } from "libphonenumber-js/max";

// Home/default timezone used when we can't derive one from the customer's phone
// number (missing/invalid number, or an unmapped country). India is our primary
// market, so we fall back to IST and always show the timezone label alongside
// the time so a fallback is never mistaken for a precise local reading.
const DEFAULT_TIME_ZONE = process.env.DEFAULT_TIMEZONE || "Asia/Kolkata";

// ISO 3166-1 alpha-2 country → representative IANA timezone. For single-timezone
// countries this is exact; for the few multi-timezone countries we pick the most
// populous zone, and the timezone label shown in the email makes any imprecision
// transparent. Extend as new customer regions appear.
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

// Zones we accept as "consistent with" a country. For single-timezone countries
// the COUNTRY_TIME_ZONE entry is the only valid zone, so they need no entry here;
// only multi-timezone countries do. Used to decide whether a browser-reported
// zone can be trusted: it's city-accurate, but only believable when it agrees
// with the country the business's phone number / address is in.
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

/** True when `zone` is a plausible timezone for a business in `country` (ISO
 *  alpha-2). Multi-timezone countries match any of their zones; every other
 *  country matches only its single mapped zone. */
export function zoneMatchesCountry(zone: string, country: string): boolean {
  const iso = country.toUpperCase();
  const zones = COUNTRY_ZONES[iso] ?? [COUNTRY_TIME_ZONE[iso]].filter(Boolean);
  return zones.includes(zone);
}

// The agent's timezone used to be stored as a display label from a 7-entry
// Australia-only picker; it's an IANA zone now. These translate the old values
// on read so existing customers keep working without a data migration.
const LEGACY_LABEL_TO_IANA: Record<string, string> = {
  "Sydney (AEST/AEDT)": "Australia/Sydney",
  "Melbourne (AEST/AEDT)": "Australia/Melbourne",
  "Brisbane (AEST)": "Australia/Brisbane",
  "Adelaide (ACST/ACDT)": "Australia/Adelaide",
  "Perth (AWST)": "Australia/Perth",
  "Darwin (ACST)": "Australia/Darwin",
  "Hobart (AEST/AEDT)": "Australia/Hobart",
};

/**
 * Old IANA identifiers → the modern zone they point at. Kept in step with the
 * client's map (src/lib/timezone.ts), which applies the same spellings to the
 * dashboard's timezone picker — storing a zone under a name the picker doesn't
 * use leaves the owner's field blank.
 */
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

/**
 * Coerce a stored timezone to a canonical IANA zone: valid zones pass through
 * (link names like Asia/Calcutta canonicalised), legacy display labels are
 * translated, and anything else returns "" so callers fall back rather than
 * emit an uninterpretable value into the prompt.
 */
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

/* ------------------------------------------------------------------ *
 *  Address → timezone (Australia).
 *  Australia is our primary market and the one multi-timezone country
 *  where offshore signups are routine, so the browser zone alone can't
 *  refine Sydney-vs-Perth. The street address can: postcode is the most
 *  reliable signal, then the uppercase state code, then a city name.
 *  Other multi-timezone countries (US/CA) aren't implemented here and
 *  fall back to browser-zone + country-default refinement.
 * ------------------------------------------------------------------ */
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

/** Best-effort AU zone from a free-text address: postcode first (most reliable —
 *  read from the end where AU addresses put it), then the state code, then a
 *  city name. "" when nothing matches. */
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

/** True when a free-text address is confidently Australian. Unambiguous state
 *  codes (NSW/ACT/VIC/QLD/TAS) count on their own; ambiguous ones (WA/SA/NT,
 *  which collide with US states and common words) count only alongside a
 *  matching AU postcode. */
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

/**
 * Best-effort IANA zone from a free-text address, scoped to a country.
 * With the country already confirmed AU (e.g. from the phone number) any AU
 * signal — including a bare postcode — is safe. With the country unknown we
 * only refine from an address that independently looks Australian, to avoid a
 * stray 4-digit street/suite number being read as a postcode. Non-AU countries
 * aren't implemented and return "".
 */
export function timeZoneFromAddress(address?: string, country?: string): string {
  const raw = address?.trim();
  if (!raw) return "";
  const iso = country?.toUpperCase();
  if (iso === "AU") return auZoneFromAddress(raw);
  if (!iso && looksAustralian(raw)) return auZoneFromAddress(raw);
  return "";
}

/**
 * Resolve the timezone a *business* operates in.
 *
 * Country comes from the strongest available signal, in order — the ordering
 * matters: an Australian business is routinely signed up by an owner or agency
 * holding an overseas personal mobile, so the personal number is the weakest
 * evidence of where the business actually is.
 *
 *   1. receptionistNumber — the AI's own number, provisioned in-region.
 *   2. businessNumber — the public line customers already call.
 *   3. mobile — the signer-upper's personal number (may be nowhere near it).
 *   4. address — a country hint when no number resolves.
 *
 * Then the city within a multi-timezone country is pinned, best signal first:
 *   a. the address — where the business physically is, authoritative even for
 *      an offshore signup (settles Sydney vs Perth that a country code can't);
 *   b. the browser zone — the signer's city, but only when it agrees with the
 *      country (otherwise it's someone travelling / offshore and is ignored);
 *   c. the country's default zone.
 *
 * Always returns a valid IANA zone. Callers should surface it for confirmation
 * rather than apply it silently — see the Rules section UI.
 */
export function resolveBusinessTimeZone(opts: {
  receptionistNumber?: string;
  businessNumber?: string;
  mobile?: string;
  address?: string;
  browserTimeZone?: string;
  /** Where to land when nothing about the person says otherwise — a
   *  white-label brand's default zone for its customers. Replaces the
   *  platform's home zone as the last resort only; a phone number, an
   *  address or the browser still win, because they are about THIS signup. */
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

/**
 * Best-effort IANA timezone for a customer based on their E.164 phone number.
 * Falls back to the home timezone when the number is missing/invalid or its
 * country isn't mapped. Callers should always render the timezone label so a
 * fallback is visibly distinguishable.
 */
export function timeZoneForPhone(mobile?: string): string {
  const raw = mobile?.trim();
  if (!raw) return DEFAULT_TIME_ZONE;
  const country = parsePhoneNumberFromString(raw)?.country;
  return (country && COUNTRY_TIME_ZONE[country]) || DEFAULT_TIME_ZONE;
}

/** Best-effort ISO 3166-1 alpha-2 country (uppercase) for an E.164 phone number,
 *  or "" when the number is missing/invalid. Used to backfill a customer's
 *  country for the regional style when it wasn't captured at onboarding. */
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

/**
 * Format a moment for a customer's local region, e.g.
 * "Jul 8, 2026, 6:20 AM GMT+5:30". Prefers the timezone the browser reported at
 * signup (exact), and falls back to one derived from the customer's phone number
 * when that's missing/invalid. The timezone label is always included so the
 * reader knows exactly which zone the time is in.
 */
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
