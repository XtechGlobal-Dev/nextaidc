import { describe, it, expect } from "vitest";

import {
  MAX_MONTHLY_INTERVAL_COUNT,
  MONTHLY_INTERVAL_COUNTS,
  cycleMonths,
  intervalLabel,
  isSupportedInterval,
} from "./billingInterval.js";

describe("cycleMonths", () => {
  it("treats a plain monthly plan as one month", () => {
    expect(cycleMonths("month", 1)).toBe(1);
  });

  it("counts a multi-month cycle", () => {
    // The case the whole feature exists for: a $300 quarterly plan is $100 MRR,
    // not $300 — this divisor is what stops it reading as triple its value.
    expect(cycleMonths("month", 3)).toBe(3);
    expect(cycleMonths("month", 12)).toBe(12);
  });

  it("still handles the legacy year and week units", () => {
    // Predates multi-month cycles; plans created before this feature may carry
    // either unit and must keep normalising the way they always did.
    expect(cycleMonths("year", 1)).toBe(12);
    expect(cycleMonths("week", 1)).toBeCloseTo(1 / 4.345, 5);
  });

  it("falls back to one month rather than dividing by zero", () => {
    // A missing or corrupt count must not blow revenue up to Infinity — every
    // MRR figure on the dashboard runs through this.
    expect(cycleMonths("month", 0)).toBe(1);
    expect(cycleMonths("month", -3)).toBe(1);
    expect(cycleMonths("month", Number.NaN)).toBe(1);
    expect(cycleMonths("month", undefined)).toBe(1);
  });

  it("divides price into a sane monthly figure", () => {
    expect(30000 / cycleMonths("month", 3)).toBe(10000); // $300/quarter = $100/mo
    expect(120000 / cycleMonths("month", 12)).toBe(10000); // $1200/year = $100/mo
  });
});

describe("intervalLabel", () => {
  it("names a one-unit cycle by its unit", () => {
    expect(intervalLabel("month", 1)).toBe("month");
  });

  it("pluralises a multi-unit cycle", () => {
    expect(intervalLabel("month", 3)).toBe("3 months");
    expect(intervalLabel("month", 6)).toBe("6 months");
  });

  it("calls a 12-month cycle a year", () => {
    // Stored as month x 12 so the Stripe price and minute allowance need no
    // special case, but nobody says "every 12 months" out loud.
    expect(intervalLabel("month", 12)).toBe("year");
  });
});

describe("isSupportedInterval", () => {
  it("accepts every count the admin form offers", () => {
    for (const c of MONTHLY_INTERVAL_COUNTS) expect(isSupportedInterval("month", c)).toBe(true);
  });

  it("rejects a cycle longer than Stripe allows", () => {
    // Stripe refuses a recurring price spanning more than a year; catching it
    // here beats discovering it as an API error after the plan row is written.
    expect(isSupportedInterval("month", MAX_MONTHLY_INTERVAL_COUNT + 1)).toBe(false);
    expect(isSupportedInterval("month", 24)).toBe(false);
  });

  it("rejects counts the form doesn't offer", () => {
    expect(isSupportedInterval("month", 5)).toBe(false);
    expect(isSupportedInterval("month", 0)).toBe(false);
  });

  it("allows legacy week/year plans only at a count of one", () => {
    expect(isSupportedInterval("year", 1)).toBe(true);
    expect(isSupportedInterval("week", 1)).toBe(true);
    expect(isSupportedInterval("year", 2)).toBe(false);
  });
});
