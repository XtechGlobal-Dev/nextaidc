/**
 * Timezone helpers for the AI Brain (client).
 *
 * The agent's timezone is stored as an IANA zone ("Australia/Perth") — the only
 * form that survives DST arithmetic and that Google Calendar accepts on an
 * event. The server resolves it from the business's phone number + address +
 * the browser's zone (see server/src/lib/phoneTimeZone.ts). These helpers cover
 * the picker, the label, and normalising the legacy display labels the field
 * used to hold ("Sydney (AEST/AEDT)") so old configs keep working on read.
 */

/** The old hardcoded picker values → the IANA zone each one meant. */
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
 * Old IANA identifiers → the modern zone they point at.
 *
 * Two names for one zone is how the timezone field ends up blank: the stored
 * value is "Asia/Kolkata" (what the server resolves for India) while
 * Intl.supportedValuesOf on ICU's older data lists "Asia/Calcutta", so no
 * option in the picker matches and the Select renders nothing.
 *
 * This map is applied to *both* the stored value and the picker's list, so the
 * two always agree on one spelling regardless of which vintage of tz data the
 * runtime ships. Deliberately not using Intl to canonicalise: engines disagree
 * on the direction (ICU maps Kolkata→Calcutta, newer data the reverse), and
 * we want the modern name in the prompt either way.
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

/** The modern spelling of a zone, so a stored value and a picker option are the
 *  same string. Unmapped zones pass through — they're already current. */
export function canonicalTimeZone(tz: string): string {
  const raw = tz.trim();
  return ALIAS_TO_CANONICAL[raw] ?? raw;
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
 * Coerce a stored timezone to a canonical IANA zone: passes valid zones
 * through (canonicalising link names like Asia/Calcutta), translates the legacy
 * display labels, and returns "" for anything else (blank, or a hand-edited
 * value we can't interpret) so callers can fall back rather than emit nonsense
 * into the prompt.
 */
export function normalizeTimeZone(value?: string): string {
  const raw = value?.trim();
  if (!raw) return "";
  if (LEGACY_LABEL_TO_IANA[raw]) return LEGACY_LABEL_TO_IANA[raw];
  return isValidTimeZone(raw) ? canonicalTimeZone(raw) : "";
}

/** The visitor's IANA zone, e.g. "Australia/Perth". Falls back to UTC on the
 *  rare runtime that won't report one, so callers always get a usable zone. */
export function browserTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

/** The city portion of an IANA zone, de-underscored: "Australia/Perth" → "Perth". */
export function timeZoneCity(tz: string): string {
  const part = tz.split("/").pop() ?? tz;
  return part.replace(/_/g, " ");
}

/** Current short abbreviation for a zone ("AEST", "GMT+5:30"), or "" if unavailable. */
export function timeZoneAbbreviation(tz: string, now: Date = new Date()): string {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      timeZoneName: "short",
    }).formatToParts(now);
    return parts.find((p) => p.type === "timeZoneName")?.value ?? "";
  } catch {
    return "";
  }
}

/**
 * Human label for a zone, e.g. "Perth (AWST)" — the city plus whichever
 * abbreviation is in effect right now, so the reading is honest about DST
 * instead of hardcoding "AEST/AEDT" the way the old list did.
 */
export function timeZoneLabel(tz: string, now: Date = new Date()): string {
  if (!isValidTimeZone(tz)) return tz;
  const abbr = timeZoneAbbreviation(tz, now);
  const city = timeZoneCity(tz);
  return abbr ? `${city} (${abbr})` : city;
}

/** Current wall-clock time in a zone, e.g. "Monday, 20 July 2026 at 9:14 am". */
export function currentTimeIn(tz: string, now: Date = new Date()): string {
  if (!isValidTimeZone(tz)) return "";
  return now.toLocaleString("en-AU", {
    timeZone: tz,
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

// Fallback for the handful of browsers without Intl.supportedValuesOf. Covers
// the regions we sell into; the picker stays usable, just shorter.
const FALLBACK_ZONES = [
  "Australia/Sydney", "Australia/Melbourne", "Australia/Brisbane", "Australia/Adelaide",
  "Australia/Perth", "Australia/Darwin", "Australia/Hobart",
  "Pacific/Auckland", "Asia/Kolkata", "Asia/Dubai", "Asia/Singapore", "Asia/Manila",
  "Europe/London", "Europe/Dublin", "Europe/Paris", "Europe/Berlin",
  "America/New_York", "America/Chicago", "America/Denver", "America/Los_Angeles",
  "America/Toronto", "America/Vancouver", "Africa/Johannesburg",
];

/** Every IANA zone the runtime knows, for the picker — each under its modern
 *  name so options match stored values, with the duplicates that creates on a
 *  runtime listing both spellings collapsed. */
export function listTimeZones(): string[] {
  const supported = (
    Intl as typeof Intl & { supportedValuesOf?: (key: string) => string[] }
  ).supportedValuesOf;
  let zones = FALLBACK_ZONES;
  try {
    const found = supported?.("timeZone");
    if (found?.length) zones = found;
  } catch {
    /* keep the fallback */
  }
  return [...new Set(zones.map(canonicalTimeZone))];
}

/**
 * Zones grouped by IANA region ("Australia", "America", …) for the picker,
 * each group ordered by city name.
 *
 * `ensure` is the zone currently selected. It's added when the runtime's list
 * doesn't contain it — an unmapped link name, or a zone from a newer tz release
 * than this browser knows — because a Select whose value has no matching option
 * renders an empty trigger, which reads as "no timezone set" even though one is.
 */
export function groupedTimeZones(ensure?: string): { region: string; zones: string[] }[] {
  const zones = listTimeZones();
  const extra = ensure?.trim();
  const all = extra && isValidTimeZone(extra) && !zones.includes(extra) ? [...zones, extra] : zones;
  const groups = new Map<string, string[]>();
  for (const zone of all) {
    const region = zone.includes("/") ? zone.split("/")[0] : "Other";
    const list = groups.get(region) ?? [];
    list.push(zone);
    groups.set(region, list);
  }
  return [...groups.entries()]
    .map(([region, zones]) => ({
      region,
      zones: zones.sort((a, b) => timeZoneCity(a).localeCompare(timeZoneCity(b))),
    }))
    .sort((a, b) => a.region.localeCompare(b.region));
}
