import { describe, it, expect } from "vitest";
import {
  canonicalTimeZone,
  normalizeTimeZone,
  groupedTimeZones,
  listTimeZones,
  timeZoneLabel,
} from "./timezone";

/** Every zone the picker would render, flattened. */
const pickerZones = (ensure?: string) => groupedTimeZones(ensure).flatMap((g) => g.zones);

describe("canonicalTimeZone", () => {
  it("maps old IANA identifiers to their modern name", () => {
    expect(canonicalTimeZone("Asia/Calcutta")).toBe("Asia/Kolkata");
    expect(canonicalTimeZone("Australia/Canberra")).toBe("Australia/Sydney");
    expect(canonicalTimeZone("US/Pacific")).toBe("America/Los_Angeles");
  });

  it("leaves modern zones untouched", () => {
    expect(canonicalTimeZone("Asia/Kolkata")).toBe("Asia/Kolkata");
    expect(canonicalTimeZone("Australia/Perth")).toBe("Australia/Perth");
  });
});

describe("the picker and the stored value agree", () => {
  it("offers India under the name the server stores, not the ICU spelling", () => {
    // The reported case: the prompt reads Asia/Kolkata, ICU lists Asia/Calcutta.
    expect(pickerZones()).toContain("Asia/Kolkata");
    expect(pickerZones()).not.toContain("Asia/Calcutta");
  });

  it("lists each zone once even when the runtime knows both spellings", () => {
    const zones = pickerZones();
    expect(new Set(zones).size).toBe(zones.length);
  });
});

describe("normalizeTimeZone", () => {
  it("canonicalises link names so the stored value matches a picker option", () => {
    const zone = normalizeTimeZone("Asia/Calcutta");
    expect(zone).toBe("Asia/Kolkata");
    expect(pickerZones()).toContain(zone);
  });

  it("still translates the legacy display labels", () => {
    expect(normalizeTimeZone("Perth (AWST)")).toBe("Australia/Perth");
  });

  it("rejects values it can't interpret", () => {
    expect(normalizeTimeZone("Somewhere/Nowhere")).toBe("");
    expect(normalizeTimeZone("  ")).toBe("");
  });
});

describe("groupedTimeZones", () => {
  it("groups by IANA region and orders each group by city", () => {
    const africa = groupedTimeZones().find((g) => g.region === "Africa");
    expect(africa?.zones.length).toBeGreaterThan(0);
    const cities = africa!.zones.map((z) => timeZoneLabel(z));
    expect([...cities].sort((a, b) => a.localeCompare(b))).toEqual(cities);
  });

  it("includes the selected zone when the runtime doesn't list it", () => {
    // Stands in for a zone from a newer tz release than this runtime ships, or
    // an old identifier we haven't mapped — either way the field must not go
    // blank on a value the owner has stored.
    const unlisted = "Australia/Currie";
    expect(listTimeZones()).not.toContain(unlisted);
    expect(pickerZones(unlisted)).toContain(unlisted);
  });

  it("doesn't duplicate a selected zone that's already listed", () => {
    const zones = pickerZones("Asia/Kolkata");
    expect(zones.filter((z) => z === "Asia/Kolkata")).toHaveLength(1);
  });

  it("ignores an invalid selected zone", () => {
    expect(pickerZones("Somewhere/Nowhere")).not.toContain("Somewhere/Nowhere");
  });
});
