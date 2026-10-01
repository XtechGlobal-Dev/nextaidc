import { describe, it, expect } from "vitest";
import type { Brand } from "@prisma/client";
import {
  brandAiAllowed,
  brandCallsAllowed,
  brandFeaturePrices,
  brandModuleSwitches,
  brandModules,
  brandOwesPlatform,
  resolveSetup,
} from "./brandSetup.js";

// Feature add-ons: a module sold as an add-on is locked until bought — but only in the EFFECTIVE set.
// The configured switches must come back untouched, or saving the brand editor would switch every
// unbought add-on off for good.

const brand = (over: Partial<Brand> = {}) =>
  ({
    modules: {},
    featurePrices: {},
    purchasedFeatures: [],
    platformFeeCents: 0,
    serviceHold: "",
    ...over,
  }) as unknown as Brand;

describe("feature add-ons", () => {
  it("locks an unbought add-on and unlocks it once bought", () => {
    const locked = brand({ featurePrices: { crm: 1500 } });
    expect(brandModules(locked).crm).toBe(false);
    expect(brandModules(locked).booking).toBe(true);
    expect(brandModules(brand({ featurePrices: { crm: 1500 }, purchasedFeatures: ["crm"] })).crm).toBe(true);
  });

  it("keeps the configured switches as the editor saved them", () => {
    expect(brandModuleSwitches(brand({ featurePrices: { crm: 1500 } })).crm).toBe(true);
  });

  it("never unlocks a module the super admin switched off, bought or not", () => {
    const off = brand({ modules: { crm: false }, featurePrices: { crm: 1500 }, purchasedFeatures: ["crm"] });
    expect(brandModules(off).crm).toBe(false);
  });

  it("ignores junk prices and unknown ids", () => {
    expect(brandFeaturePrices(brand({ featurePrices: { crm: 0, booking: -5, nope: 100, transfer: 1200 } }))).toEqual({
      transfer: 1200,
    });
  });

  it("never prices a default feature as an add-on, even if one is stored", () => {
    // Legacy data (set before these became default-only) self-heals: it reads as plain included/off.
    expect(brandFeaturePrices(brand({ featurePrices: { whatsapp: 900, smsToCaller: 500 } }))).toEqual({});
    const stale = brand({ modules: { whatsapp: true }, featurePrices: { whatsapp: 900 }, purchasedFeatures: [] });
    expect(brandModules(stale).whatsapp).toBe(true);
  });

  it("refuses to save an add-on price for a default feature", () => {
    expect(() => resolveSetup({ featurePrices: { whatsapp: 900 } })).toThrow(/default feature/);
  });

  it("owes the platform with a fee or a bought add-on", () => {
    expect(brandOwesPlatform(brand())).toBe(false);
    expect(brandOwesPlatform(brand({ platformFeeCents: 100 }))).toBe(true);
    expect(brandOwesPlatform(brand({ purchasedFeatures: ["crm"] }))).toBe(true);
  });
});

describe("holds", () => {
  it("a minutes cap stops calls but not texts; ai and billing stop both", () => {
    expect(brandCallsAllowed(brand({ serviceHold: "minutes" }))).toBe(false);
    expect(brandAiAllowed(brand({ serviceHold: "minutes" }))).toBe(true);
    for (const hold of ["ai", "billing"]) {
      expect(brandCallsAllowed(brand({ serviceHold: hold }))).toBe(false);
      expect(brandAiAllowed(brand({ serviceHold: hold }))).toBe(false);
    }
    expect(brandCallsAllowed(null)).toBe(true);
  });
});

describe("resolveSetup — billing fields", () => {
  it("accepts a fee, currency, add-on prices and caps", () => {
    expect(
      resolveSetup({
        platformFeeCents: 4900,
        platformFeeCurrency: "USD",
        featurePrices: { crm: 1500, nope: 10 },
        monthlyMinuteLimit: 5000,
        monthlyAiLimit: null,
      }),
    ).toEqual({
      platformFeeCents: 4900,
      platformFeeCurrency: "usd",
      featurePrices: { crm: 1500 },
      monthlyMinuteLimit: 5000,
      monthlyAiLimit: null,
    });
  });

  it("refuses a free add-on and a bad currency", () => {
    expect(() => resolveSetup({ featurePrices: { crm: 0 } })).toThrow(/above zero/);
    expect(() => resolveSetup({ platformFeeCurrency: "dollars" })).toThrow(/three-letter/);
  });
});
