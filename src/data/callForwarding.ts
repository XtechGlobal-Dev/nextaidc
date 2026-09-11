import { parsePhoneNumberFromString } from "libphonenumber-js/max";

/* ------------------------------------------------------------------ *
 *  Call-forwarding instructions engine.
 *
 *  The owner keeps their existing published number and forwards its
 *  calls to the AI number at their carrier. The actual forwarding is a
 *  carrier-side action on the OWNER's phone (we can't program another
 *  carrier), so this module just generates the correct dial codes:
 *
 *   - mode "all"      → unconditional forwarding (every call → AI)
 *   - mode "overflow" → conditional forwarding (busy / no-answer /
 *                       unreachable → AI; the owner still answers first)
 *
 *  Codes are carrier/country specific. AU mobiles + most GSM networks
 *  use the standard MMI codes (*21*, *61*, *67*, *62*); US carriers use
 *  the CLASS star codes (*72, *90, *92). The destination is the AI
 *  number, formatted per the code family.
 * ------------------------------------------------------------------ */

export type ForwardingMode = "all" | "overflow";
export type ForwardingCountry = "au" | "us" | "generic";

export interface ForwardingCarrier {
  id: string;
  label: string;
  /** GSM MMI codes (au/generic) or US CLASS codes. */
  family: "gsm" | "us";
  /** Optional caveat shown for this carrier (e.g. landline differences). */
  note?: string;
}

export interface ForwardingCountryDef {
  id: ForwardingCountry;
  label: string;
  carriers: ForwardingCarrier[];
}

/** A single dial instruction: a human label + the exact code to enter. */
export interface ForwardingCode {
  label: string;
  code: string;
}

export interface ForwardingRecipe {
  /** Code(s) to switch forwarding on for the chosen mode. */
  activate: ForwardingCode[];
  /** Code(s) to switch it back off. */
  cancel: ForwardingCode[];
  /** Plain-language steps to follow on the owner's phone. */
  steps: string[];
  /** Extra caveat (carrier/landline), when relevant. */
  note?: string;
}

/** Countries + carriers offered in the setup UI. Order = display order. */
export const FORWARDING_COUNTRIES: ForwardingCountryDef[] = [
  {
    id: "au",
    label: "Australia",
    carriers: [
      { id: "telstra", label: "Telstra", family: "gsm" },
      { id: "optus", label: "Optus", family: "gsm" },
      { id: "vodafone", label: "Vodafone", family: "gsm" },
      {
        id: "other-au",
        label: "Other / landline",
        family: "gsm",
        note: "Landline forwarding can differ by provider. If these codes don't work, ask your provider to enable “call forwarding” to your AI number.",
      },
    ],
  },
  {
    id: "us",
    label: "United States",
    carriers: [
      { id: "us-generic", label: "Most US carriers", family: "us" },
      {
        id: "other-us",
        label: "Other / landline",
        family: "us",
        note: "US forwarding codes vary by carrier. If these don't work, search “call forwarding” for your carrier or ask them to enable it.",
      },
    ],
  },
  {
    id: "generic",
    label: "Other country (generic GSM)",
    carriers: [
      {
        id: "gsm",
        label: "Standard GSM codes",
        family: "gsm",
        note: "These standard GSM codes work on most mobile networks worldwide — confirm with your carrier if a code is rejected.",
      },
    ],
  },
];

/** Look up a carrier definition by country + carrier id (falls back sensibly). */
export function findCarrier(country: ForwardingCountry, carrierId: string): ForwardingCarrier {
  const def = FORWARDING_COUNTRIES.find((c) => c.id === country) ?? FORWARDING_COUNTRIES[0];
  return def.carriers.find((c) => c.id === carrierId) ?? def.carriers[0];
}

/**
 * Format the AI (destination) number for a code family.
 *  - GSM codes take the full international number (+countrycode…).
 *  - US CLASS codes are dialed domestically, so a US destination becomes
 *    1 + national number; a non-US destination stays international.
 */
export function formatDestination(aiNumber: string, family: "gsm" | "us"): string {
  const parsed = parsePhoneNumberFromString(aiNumber.trim());
  if (parsed) {
    if (family === "us") {
      return parsed.countryCallingCode === "1" ? `1${parsed.nationalNumber}` : parsed.number;
    }
    return parsed.number; // E.164, e.g. +61412345678
  }
  // Unparseable (e.g. a masked/partial number) — keep digits, preserve intl "+".
  const raw = aiNumber.replace(/[^\d+]/g, "");
  const digits = raw.replace(/\+/g, "");
  if (family === "us") return digits;
  return raw.startsWith("+") ? `+${digits}` : `+${digits}`;
}

/**
 * The destination as it should actually be KEYED INTO a forwarding code.
 *
 * A forwarding code is dialled on the user's own phone, on their own network, so
 * the destination is a domestic call: carriers want the national form (AU
 * `0468159801`, not `+61468159801`). It also has to be — a landline keypad has
 * no `+` key at all, which made the international form impossible to enter.
 *
 * Only safe when the AI number is in the SAME country the user is dialling from;
 * a cross-border destination has no national form there, so it stays E.164 and
 * the UI warns that it needs an international dial-out prefix.
 *
 * `iso` is the country the user picked ("Where's your phone?"), lowercase.
 */
export function dialDestination(aiNumber: string, iso: string | undefined | null): string {
  const parsed = parsePhoneNumberFromString(aiNumber.trim());
  if (parsed?.country && iso && parsed.country.toLowerCase() === iso.toLowerCase()) {
    // Digits only — a code is keyed in unbroken, so drop the display spacing.
    return parsed.formatNational().replace(/\D/g, "");
  }
  return formatDestination(aiNumber, "gsm");
}

/** Whether the destination had to stay in international (+…) form because the AI
 *  number isn't in the country being dialled from — which a landline can't key. */
export function isForeignDestination(aiNumber: string, iso: string | undefined | null): boolean {
  const parsed = parsePhoneNumberFromString(aiNumber.trim());
  if (!parsed?.country || !iso) return false;
  return parsed.country.toLowerCase() !== iso.toLowerCase();
}

/** International dial-out (IDD) prefixes — what you key INSTEAD of "+" when the
 *  destination is in another country. Most of the world uses 00; the exceptions
 *  here are the countries we offer numbers in. */
const IDD_PREFIXES: Record<string, string> = {
  au: "0011",
  us: "011",
  ca: "011",
  gb: "00",
  nz: "00",
};

/** The prefix that replaces "+" when dialling out of `iso` (defaults to 00). */
export function internationalPrefix(iso: string | undefined | null): string {
  return (iso && IDD_PREFIXES[iso.toLowerCase()]) || "00";
}

/**
 * Build the dial codes + steps for a given AI number, country/carrier and mode.
 * Pure and deterministic — the single source of truth for every forwarding UI.
 */
export function buildForwarding(
  aiNumber: string,
  country: ForwardingCountry,
  carrierId: string,
  mode: ForwardingMode,
): ForwardingRecipe {
  const carrier = findCarrier(country, carrierId);
  const dest = formatDestination(aiNumber, carrier.family);

  if (carrier.family === "us") {
    if (mode === "all") {
      return {
        activate: [{ label: "Forward all calls", code: `*72${dest}` }],
        cancel: [{ label: "Turn forwarding off", code: "*73" }],
        steps: [
          "Open your phone's keypad.",
          `Dial *72 immediately followed by your AI number: *72${dest}`,
          "Press call and wait for the confirmation tone or message, then hang up.",
          "Test it: call your existing number — your AI should answer.",
          "To turn forwarding off later, dial *73.",
        ],
        note: carrier.note,
      };
    }
    return {
      activate: [
        { label: "When busy", code: `*90${dest}` },
        { label: "When unanswered", code: `*92${dest}` },
      ],
      cancel: [
        { label: "Cancel busy", code: "*91" },
        { label: "Cancel unanswered", code: "*93" },
      ],
      steps: [
        "Open your phone's keypad.",
        `For busy calls: dial *90 then your AI number (*90${dest}) and press call.`,
        `For unanswered calls: dial *92 then your AI number (*92${dest}) and press call.`,
        "Now you still answer first — only busy or missed calls roll to your AI.",
        "To turn these off later, dial *91 (busy) and *93 (unanswered).",
      ],
      note: carrier.note,
    };
  }

  // GSM MMI codes (AU mobiles + generic worldwide).
  if (mode === "all") {
    return {
      activate: [{ label: "Forward all calls", code: `*21*${dest}#` }],
      cancel: [{ label: "Turn forwarding off", code: "#21#" }],
      steps: [
        "Open your phone's keypad.",
        `Enter *21*${dest}# and press call.`,
        "You'll see an on-screen confirmation that all calls are being forwarded.",
        "Test it: call your existing number — your AI should answer.",
        "To turn forwarding off later, dial #21#.",
      ],
      note: carrier.note,
    };
  }
  return {
    activate: [
      { label: "When unanswered", code: `*61*${dest}#` },
      { label: "When busy", code: `*67*${dest}#` },
      { label: "When unreachable", code: `*62*${dest}#` },
    ],
    cancel: [{ label: "Turn all off", code: "##002#" }],
    steps: [
      "Open your phone's keypad.",
      `Enter each code and press call: *61*${dest}# (no answer), *67*${dest}# (busy), *62*${dest}# (switched off / no signal).`,
      "Now you still answer first — only unanswered, busy or unreachable calls roll to your AI.",
      "To turn all forwarding off later, dial ##002#.",
    ],
    note: carrier.note,
  };
}

/* ------------------------------------------------------------------ *
 *  Full forwarding-code reference tables.
 *
 *  The step-by-step guide above walks a user through ONE scenario at a
 *  time. This is the complete carrier-style lookup — every diversion
 *  type (all calls / no answer / unreachable / busy) with its activate,
 *  deactivate and check codes — shown in an accordion so a user can find
 *  the exact code for their situation instead of guessing from a single
 *  misleading line. Mirrors the tables carriers publish (see the doc
 *  links below).
 * ------------------------------------------------------------------ */

/** One diversion type and its dial codes. The "turn on" code is split AROUND the
 *  number the user substitutes (prefix + <AI number> + suffix) so the UI can show
 *  clearly which part is the fixed code and which part is their number. */
export interface GsmCodeRow {
  /** Short scenario name, e.g. "No answer". */
  scenario: string;
  /** When it applies, in plain words. */
  when: string;
  /** "Turn on" code, split around the AI number. null = no activation code
   *  (the turn-all-off row). */
  activate: { prefix: string; suffix: string } | null;
  /** Code that switches it OFF (no number needed). */
  deactivate: string;
  /** Code that reports the current setting (empty when the family has none). */
  check: string;
}

/** Whether the reference table has a "check status" column (GSM does, US doesn't). */
export function codeTableHasCheck(family: "gsm" | "us"): boolean {
  return family === "gsm";
}

/**
 * The forwarding-code table for a code family. GSM uses the universal MMI codes
 * (**21*<number>#, matching Telstra/Vodafone's own tables); US uses the CLASS
 * star codes (no unreachable case, no check code). The "turn on" code is returned
 * split around the number so the UI can highlight where the AI number goes — pass
 * the row + a formatted number to activateCode() to get the full dialable string.
 */
export function buildGsmCodeTable(family: "gsm" | "us", carrierId?: string): GsmCodeRow[] {
  if (family === "us") {
    return [
      { scenario: "All calls", when: "Every call goes straight to your AI", activate: { prefix: "*72", suffix: "" }, deactivate: "*73", check: "" },
      { scenario: "No answer", when: "You don't pick up in time", activate: { prefix: "*92", suffix: "" }, deactivate: "*93", check: "" },
      { scenario: "Busy", when: "You're already on a call", activate: { prefix: "*90", suffix: "" }, deactivate: "*91", check: "" },
    ];
  }
  // GSM MMI — `**<code>*<number>#` register+activate, `##<code>#` erase,
  // `*#<code>#` interrogate. `##002#` clears every diversion at once.
  // Telstra documents the voice basic-service class `*11` on the activate
  // sequence (`**<code>*<number>*11#`) — so match their official form exactly for
  // Telstra; every other GSM carrier uses the plain `#`.
  const activateSuffix = carrierId === "telstra" ? "*11#" : "#";
  const gsm = (code: string): Omit<GsmCodeRow, "scenario" | "when"> => ({
    activate: { prefix: `**${code}*`, suffix: activateSuffix },
    deactivate: `##${code}#`,
    check: `*#${code}#`,
  });
  return [
    { scenario: "All calls", when: "Every call goes straight to your AI", ...gsm("21") },
    { scenario: "No answer", when: "You don't pick up in time", ...gsm("61") },
    { scenario: "Unreachable", when: "Phone is off or has no signal", ...gsm("62") },
    { scenario: "Busy", when: "You're already on a call", ...gsm("67") },
    { scenario: "Turn all off", when: "Cancel every diversion at once", activate: null, deactivate: "##002#", check: "" },
  ];
}

/** The full dialable "turn on" code — the fixed prefix/suffix with the number
 *  spliced in. Returns null for a row with no activation code (turn-all-off). */
export function activateCode(row: GsmCodeRow, dest: string): string | null {
  if (!row.activate) return null;
  return `${row.activate.prefix}${dest}${row.activate.suffix}`;
}

/** A carrier's official call-forwarding help page. */
export interface CarrierDocLink {
  label: string;
  url: string;
}

/**
 * Official carrier call-forwarding guides, by country ISO (lowercase). Shown so a
 * user whose exact codes differ (or who prefers an in-app toggle) can follow their
 * own carrier's instructions. Curated + editable — verified links, newest checked
 * July 2026. Falls back to nothing (a generic note is shown instead).
 */
export const CARRIER_DOC_LINKS: Record<string, CarrierDocLink[]> = {
  au: [
    { label: "Telstra", url: "https://www.telstra.com.au/small-business/online-support/mobiles-devices/forward-calls-on-mobile" },
    { label: "Optus", url: "https://www.optus.com.au/support/answer/manage_call_diversions_on_your_mobile_phone_1764" },
    { label: "Vodafone", url: "https://www.vodafone.com.au/support/device/call-forwarding" },
  ],
  in: [
    { label: "Jio", url: "https://www.jio.com/help/faq/mobile/services/hd-voice/what-are-different-types-of-call-forwarding/" },
    { label: "Airtel", url: "https://www.airtel.in/support/" },
  ],
  us: [
    { label: "Verizon", url: "https://www.verizon.com/support/call-forwarding-video/" },
    { label: "AT&T", url: "https://www.att.com/support/article/wireless/KM1009508/" },
    { label: "T-Mobile", url: "https://www.t-mobile.com/support/plans-features/call-forwarding" },
  ],
  gb: [
    { label: "EE", url: "https://ee.co.uk/help/phones-and-device/calls-contacts-and-messaging/divert-calls-to-another-number" },
    { label: "O2", url: "https://www.o2.co.uk/help/device-and-sim-support/call-and-message-settings" },
    { label: "Vodafone UK", url: "https://www.vodafone.co.uk/help-and-information/costs-and-charges/diverting-your-calls" },
  ],
  nz: [
    { label: "Spark", url: "https://www.spark.co.nz/help/mobile/mobile-services/" },
    { label: "One NZ", url: "https://one.nz/help/" },
  ],
};

/** Official carrier guides for a country ISO (lowercase); empty when none listed. */
export function carrierDocLinks(iso: string | undefined | null): CarrierDocLink[] {
  return (iso && CARRIER_DOC_LINKS[iso.toLowerCase()]) || [];
}

/** Guess the best default country bucket from a phone number's calling code. */
export function defaultForwardingCountry(phone: string | undefined | null): ForwardingCountry {
  if (phone) {
    const parsed = parsePhoneNumberFromString(phone.trim());
    if (parsed?.countryCallingCode === "61") return "au";
    if (parsed?.countryCallingCode === "1") return "us";
    if (parsed) return "generic";
  }
  return "au"; // AU-first product default
}
