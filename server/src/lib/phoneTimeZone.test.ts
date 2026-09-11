import { describe, it, expect } from "vitest";
import {
  resolveBusinessTimeZone,
  normalizeTimeZone,
  zoneMatchesCountry,
  timeZoneLabel,
  timeZoneFromAddress,
  isoCountryFromAddress,
} from "./phoneTimeZone.js";

// Real numbers aren't needed — libphonenumber only has to recognise the country.
const AU_MOBILE = "+61412345678";
/** Melbourne landline — the "business number" in the reported case. */
const AU_LANDLINE = "+61370656490";
const US_MOBILE = "+12125550123";
const IN_MOBILE = "+919876543210";

// The reported real address: a Glen Waverley (Melbourne / VIC) business.
const MELB_ADDRESS = "Unit 1, Ground Floor, Building 3/540 Springvale Rd, Glen Waverley VIC 3150";
const PERTH_ADDRESS = "12 Hay St, Perth WA 6000";

describe("resolveBusinessTimeZone", () => {
  it("uses the address to pin the city within the phone's country", () => {
    // AU phone gives the country; the Melbourne address settles Melbourne vs
    // Sydney that the country code alone can't.
    expect(
      resolveBusinessTimeZone({ mobile: AU_MOBILE, address: MELB_ADDRESS }),
    ).toBe("Australia/Melbourne");
  });

  it("uses the address city even when the owner signs up from overseas", () => {
    // The exact reported bug: AU business, Indian personal mobile, offshore
    // browser. The business number + address must win over the mobile, and the
    // Perth address must beat the (disagreeing, ignored) Indian browser zone.
    expect(
      resolveBusinessTimeZone({
        businessNumber: AU_LANDLINE,
        mobile: IN_MOBILE,
        address: PERTH_ADDRESS,
        browserTimeZone: "Asia/Kolkata",
      }),
    ).toBe("Australia/Perth");
  });

  it("prefers the business number over an overseas personal mobile", () => {
    expect(
      resolveBusinessTimeZone({ businessNumber: AU_LANDLINE, mobile: IN_MOBILE }),
    ).toBe("Australia/Sydney"); // AU default when no city signal
  });

  it("refines to the browser city when it agrees with the country and there's no address", () => {
    expect(
      resolveBusinessTimeZone({ mobile: AU_MOBILE, browserTimeZone: "Australia/Perth" }),
    ).toBe("Australia/Perth");
  });

  it("ignores a browser zone from a different country than the business", () => {
    expect(
      resolveBusinessTimeZone({ mobile: AU_MOBILE, browserTimeZone: "Asia/Manila" }),
    ).toBe("Australia/Sydney");
  });

  it("resolves country from an Australian address when there's no phone number", () => {
    expect(resolveBusinessTimeZone({ address: MELB_ADDRESS })).toBe("Australia/Melbourne");
  });

  it("falls back to the phone's country zone with no address or browser zone", () => {
    expect(resolveBusinessTimeZone({ mobile: IN_MOBILE })).toBe("Asia/Kolkata");
  });

  it("lets the receptionist number override everything else", () => {
    expect(
      resolveBusinessTimeZone({
        receptionistNumber: US_MOBILE,
        businessNumber: AU_LANDLINE,
        mobile: IN_MOBILE,
      }),
    ).toBe("America/New_York");
  });

  it("uses the browser zone alone when nothing else resolves", () => {
    expect(resolveBusinessTimeZone({ browserTimeZone: "Europe/Lisbon" })).toBe("Europe/Lisbon");
  });

  it("always returns something usable with no signals at all", () => {
    expect(resolveBusinessTimeZone({})).toBe("Asia/Kolkata");
  });
});

describe("timeZoneFromAddress", () => {
  it("reads the postcode for a country already known to be AU", () => {
    expect(timeZoneFromAddress(MELB_ADDRESS, "AU")).toBe("Australia/Melbourne");
    expect(timeZoneFromAddress(PERTH_ADDRESS, "AU")).toBe("Australia/Perth");
    expect(timeZoneFromAddress("5 King William St, Adelaide SA 5000", "AU")).toBe("Australia/Adelaide");
    expect(timeZoneFromAddress("1 Queen St, Brisbane QLD 4000", "AU")).toBe("Australia/Brisbane");
  });

  it("matches a city name when there's no postcode or state code", () => {
    expect(timeZoneFromAddress("Shop 4, Fremantle", "AU")).toBe("Australia/Perth");
  });

  it("won't read a stray 4-digit number as a postcode when the country is unknown", () => {
    // A US address with 'Suite 4000' must not be mistaken for AU/Queensland.
    expect(timeZoneFromAddress("Suite 4000, 350 5th Ave, New York")).toBe("");
  });

  it("returns blank for a non-AU country (not implemented)", () => {
    expect(timeZoneFromAddress("350 5th Ave, New York NY 10118", "US")).toBe("");
  });
});

describe("isoCountryFromAddress", () => {
  it("recognises Australia from an unambiguous state code", () => {
    expect(isoCountryFromAddress(MELB_ADDRESS)).toBe("AU"); // VIC
    expect(isoCountryFromAddress("… NSW 2000")).toBe("AU");
  });

  it("recognises Australia from an ambiguous state code only with a matching postcode", () => {
    expect(isoCountryFromAddress(PERTH_ADDRESS)).toBe("AU"); // WA + 6000
    expect(isoCountryFromAddress("Seattle WA 98101")).toBe(""); // WA but US postcode
  });

  it("returns blank for a non-Australian address", () => {
    expect(isoCountryFromAddress("350 5th Ave, New York NY 10118")).toBe("");
  });
});

describe("zoneMatchesCountry", () => {
  it("accepts any zone of a multi-timezone country", () => {
    expect(zoneMatchesCountry("Australia/Perth", "AU")).toBe(true);
    expect(zoneMatchesCountry("America/Los_Angeles", "US")).toBe(true);
  });

  it("rejects a zone from another country", () => {
    expect(zoneMatchesCountry("Asia/Manila", "AU")).toBe(false);
  });

  it("matches the single zone of a single-timezone country", () => {
    expect(zoneMatchesCountry("Asia/Kolkata", "IN")).toBe(true);
    expect(zoneMatchesCountry("Asia/Dubai", "IN")).toBe(false);
  });
});

describe("normalizeTimeZone", () => {
  it("translates the legacy display labels so existing customers keep working", () => {
    expect(normalizeTimeZone("Sydney (AEST/AEDT)")).toBe("Australia/Sydney");
    expect(normalizeTimeZone("Perth (AWST)")).toBe("Australia/Perth");
  });

  it("passes valid IANA zones through", () => {
    expect(normalizeTimeZone("America/Chicago")).toBe("America/Chicago");
  });

  it("stores old identifiers under the modern name the dashboard picker offers", () => {
    expect(normalizeTimeZone("Asia/Calcutta")).toBe("Asia/Kolkata");
    expect(normalizeTimeZone("Australia/Canberra")).toBe("Australia/Sydney");
  });

  it("returns blank for values it can't interpret", () => {
    expect(normalizeTimeZone("")).toBe("");
    expect(normalizeTimeZone(undefined)).toBe("");
    expect(normalizeTimeZone("Sydney-ish, mate")).toBe("");
  });
});

describe("resolveBusinessTimeZone — modern names", () => {
  it("returns a browser-reported old identifier under its modern name", () => {
    // A Canberra browser reports Australia/Canberra, which the AU zone list
    // accepts; storing it verbatim would leave the picker with no match.
    expect(
      resolveBusinessTimeZone({ businessNumber: AU_MOBILE, browserTimeZone: "Australia/Canberra" }),
    ).toBe("Australia/Sydney");
  });

  it("does the same with no country to go on", () => {
    expect(resolveBusinessTimeZone({ browserTimeZone: "Asia/Calcutta" })).toBe("Asia/Kolkata");
  });
});

describe("timeZoneLabel", () => {
  it("renders city plus the abbreviation in effect, tracking DST", () => {
    expect(timeZoneLabel("Australia/Sydney", new Date("2026-01-15T00:00:00Z"))).toBe("Sydney (GMT+11)");
    expect(timeZoneLabel("Australia/Sydney", new Date("2026-07-15T00:00:00Z"))).toBe("Sydney (GMT+10)");
  });

  it("de-underscores multi-word cities", () => {
    expect(timeZoneLabel("America/Los_Angeles", new Date("2026-07-15T00:00:00Z"))).toContain("Los Angeles");
  });
});
