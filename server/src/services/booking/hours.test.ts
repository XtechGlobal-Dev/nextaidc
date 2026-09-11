import { describe, it, expect } from "vitest";
import {
  defaultWorkingHours,
  parseWorkingHours,
  serializeWorkingHours,
  generateSlots,
  formatLocal,
} from "./hours.js";
import { resolveSlotInstant } from "./engine.js";
import type { BookingConfig } from "./config.js";

describe("parseWorkingHours", () => {
  it("returns Mon–Fri 9–5 defaults for blank input", () => {
    const h = parseWorkingHours("");
    expect(h[1]).toEqual({ open: true, start: "09:00", end: "17:00" });
    expect(h[0].open).toBe(false); // Sunday closed
    expect(h[6].open).toBe(false); // Saturday closed
  });

  it("parses stored JSON and fills missing days from defaults", () => {
    const h = parseWorkingHours(JSON.stringify({ "1": { open: true, start: "08:00", end: "12:00" } }));
    expect(h[1]).toEqual({ open: true, start: "08:00", end: "12:00" });
    expect(h[2].open).toBe(true); // untouched → default weekday
  });

  it("falls back to defaults on malformed JSON", () => {
    expect(parseWorkingHours("{not json")).toEqual(defaultWorkingHours());
  });

  it("round-trips through serialize", () => {
    const h = defaultWorkingHours();
    expect(parseWorkingHours(serializeWorkingHours(h))).toEqual(h);
  });
});

describe("generateSlots", () => {
  const hours = defaultWorkingHours(); // 09:00–17:00 weekdays

  it("generates 30-min slots across the open window", () => {
    // 2026-07-22 is a Wednesday.
    const slots = generateSlots("2026-07-22", hours, 30, "UTC");
    expect(slots.length).toBe(16); // 9:00 → 16:30 inclusive (8h / 0.5h)
    expect(slots[0].label).toBe("9:00 AM");
    expect(slots[slots.length - 1].label).toBe("4:30 PM");
    expect(slots[0].startISO).toBe("2026-07-22T09:00:00.000Z");
  });

  it("returns no slots on a closed day", () => {
    // 2026-07-19 is a Sunday (closed by default).
    expect(generateSlots("2026-07-19", hours, 30, "UTC")).toEqual([]);
  });

  it("only includes slots that fit entirely in the window", () => {
    // 45-min slots in a 9–17 (480 min) window → 10 full slots (last 15:45–16:30).
    const slots = generateSlots("2026-07-22", hours, 45, "UTC");
    expect(slots.length).toBe(10);
    expect(slots[slots.length - 1].label).toBe("3:45 PM");
    expect(slots[slots.length - 1].endISO).toBe("2026-07-22T16:30:00.000Z");
  });

  it("handles DST correctly (America/New_York)", () => {
    // Winter (EST, UTC-5): 09:00 local → 14:00 UTC.
    const winter = generateSlots("2026-01-15", hours, 60, "America/New_York");
    expect(winter[0].startISO).toBe("2026-01-15T14:00:00.000Z");
    // Summer (EDT, UTC-4): 09:00 local → 13:00 UTC.
    const summer = generateSlots("2026-07-15", hours, 60, "America/New_York");
    expect(summer[0].startISO).toBe("2026-07-15T13:00:00.000Z");
  });

  it("resolves the weekday in the owner's timezone", () => {
    // 2026-07-19 is Sunday everywhere; still closed in Sydney.
    expect(generateSlots("2026-07-19", hours, 30, "Australia/Sydney")).toEqual([]);
  });
});

describe("formatLocal", () => {
  it("renders an instant in the owner's timezone", () => {
    // 13:00 UTC on 2026-07-22 is 23:00 in Sydney (UTC+10, no DST in July).
    const label = formatLocal("2026-07-22T13:00:00.000Z", "Australia/Sydney");
    expect(label).toContain("11:00 PM");
    expect(label).toContain("Wednesday");
  });
});

describe("resolveSlotInstant (match by instant, not string)", () => {
  const config: BookingConfig = {
    connected: true,
    autoBookEnabled: true,
    canAutoBook: true,
    durationMin: 30,
    calendarId: "primary",
    timezone: "UTC",
    hours: defaultWorkingHours(),
    businessName: "Example Co",
  };

  it("matches a 24h time to the slot", () => {
    const r = resolveSlotInstant(config, "2026-07-22", "15:00");
    expect(r?.startISO).toBe("2026-07-22T15:00:00.000Z");
  });

  it("matches a 12h label to the same slot", () => {
    const r = resolveSlotInstant(config, "2026-07-22", "3:00 PM");
    expect(r?.startISO).toBe("2026-07-22T15:00:00.000Z");
  });

  it("accepts a bare '3pm' form", () => {
    const r = resolveSlotInstant(config, "2026-07-22", "3pm");
    expect(r?.startISO).toBe("2026-07-22T15:00:00.000Z");
  });

  it("returns null for a time outside the slot grid", () => {
    expect(resolveSlotInstant(config, "2026-07-22", "18:00")).toBeNull();
  });

  it("returns null on a closed day", () => {
    expect(resolveSlotInstant(config, "2026-07-19", "10:00")).toBeNull();
  });
});
