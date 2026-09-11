import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../prisma.js", () => ({
  prisma: { platformSetting: { findUnique: vi.fn() } },
}));

vi.mock("./stripe.js", () => ({ endTrialNow: vi.fn() }));

import { prisma } from "../prisma.js";
import {
  DEFAULT_FX_RATES,
  REPORTING_CURRENCY,
  getFxRates,
  toReportingCents,
} from "./billing.js";

const findUnique = prisma.platformSetting.findUnique as unknown as ReturnType<typeof vi.fn>;

/* Revenue used to be summed straight off `priceCents` regardless of currency,
 * so A$89 + $299 reported as "388" — a number in no currency at all. These pin
 * the normalisation that replaced it. */

describe("toReportingCents", () => {
  const rates = { aud: 0.71 };

  it("passes the reporting currency straight through", () => {
    expect(toReportingCents(29900, "usd", rates)).toEqual({ cents: 29900, unconvertible: false });
  });

  it("converts a foreign currency at the configured rate", () => {
    // A$89 → US$63.19
    expect(toReportingCents(8900, "aud", rates).cents).toBeCloseTo(6319, 0);
  });

  it("is case-insensitive about the currency code", () => {
    expect(toReportingCents(8900, "AUD", rates).cents).toBeCloseTo(6319, 0);
  });

  it("treats a missing currency as the reporting currency", () => {
    // Plans default to "usd", but a null/empty column must not be read as a
    // foreign currency and silently flagged unconvertible.
    expect(toReportingCents(29900, "", rates)).toEqual({ cents: 29900, unconvertible: false });
  });

  it("flags an unrated currency instead of inventing a number", () => {
    // Passes through unconverted — no worse than the old behaviour — but says so
    // rather than publishing a total nobody can source.
    const out = toReportingCents(5000, "eur", rates);
    expect(out.cents).toBe(5000);
    expect(out.unconvertible).toBe(true);
  });

  it("stops A$89 + $299 from summing to 388", () => {
    // The exact bug this exists to prevent.
    const total =
      toReportingCents(8900, "aud", rates).cents + toReportingCents(29900, "usd", rates).cents;
    expect(Math.round(total)).toBe(36219); // US$362.19, not "$388"
    expect(REPORTING_CURRENCY).toBe("usd");
  });
});

describe("getFxRates", () => {
  beforeEach(() => findUnique.mockReset());

  it("falls back to the defaults when nothing is configured", async () => {
    findUnique.mockResolvedValue(null);
    expect(await getFxRates()).toEqual(DEFAULT_FX_RATES);
  });

  it("reads admin-set rates", async () => {
    findUnique.mockResolvedValue({ value: JSON.stringify({ aud: 0.66, eur: 1.08 }) });
    expect(await getFxRates()).toEqual({ aud: 0.66, eur: 1.08 });
  });

  it("keeps the dashboard up when the stored value is malformed", async () => {
    // A bad settings row must not take every revenue figure down with it.
    findUnique.mockResolvedValue({ value: "not json" });
    expect(await getFxRates()).toEqual(DEFAULT_FX_RATES);
    findUnique.mockResolvedValue({ value: JSON.stringify(["aud", 0.71]) });
    expect(await getFxRates()).toEqual(DEFAULT_FX_RATES);
  });

  it("ignores a zero or negative rate rather than erasing that revenue", async () => {
    // 0 would wipe every AUD subscription out of MRR with no error anywhere.
    findUnique.mockResolvedValue({ value: JSON.stringify({ aud: 0 }) });
    expect((await getFxRates()).aud).toBe(DEFAULT_FX_RATES.aud);
    findUnique.mockResolvedValue({ value: JSON.stringify({ aud: -1 }) });
    expect((await getFxRates()).aud).toBe(DEFAULT_FX_RATES.aud);
  });

  it("lowercases codes so 'AUD' and 'aud' are the same rate", async () => {
    findUnique.mockResolvedValue({ value: JSON.stringify({ AUD: 0.68 }) });
    expect((await getFxRates()).aud).toBe(0.68);
  });
});
