import { describe, it, expect } from "vitest";
import type { Brand } from "@prisma/client";
import {
  BRAND_MODULES,
  brandAllowsSignup,
  brandCardRequired,
  brandModules,
  brandPlanIds,
  brandScripts,
  normalizeHttpUrl,
  resolveSetup,
} from "./brandSetup.js";

/* ------------------------------------------------------------------ *
 *  The policy half of a brand: how stored values are read (always with
 *  a platform answer for "no brand"), and how admin input is checked.
 * ------------------------------------------------------------------ */

const brand = (over: Record<string, unknown> = {}) => ({ id: "b", name: "Acme", ...over }) as unknown as Brand;

describe("readers", () => {
  it("treats a missing module key as ON, and only an explicit false as OFF", () => {
    expect(brandModules(null)).toEqual(
      Object.fromEntries(BRAND_MODULES.map((m) => [m.id, true])),
    );
    // A brand created before a module existed keeps getting it.
    expect(brandModules(brand({ modules: {} })).booking).toBe(true);
    expect(brandModules(brand({ modules: { booking: false } })).booking).toBe(false);
    expect(brandModules(brand({ modules: { booking: false } })).crm).toBe(true);
    // Garbage in the column is not a reason to hide anything.
    expect(brandModules(brand({ modules: "nope" })).transfer).toBe(true);
    expect(brandModules(brand({ modules: null })).transfer).toBe(true);
  });

  it("reads plan ids defensively", () => {
    expect(brandPlanIds(null)).toEqual([]);
    expect(brandPlanIds(brand({ planIds: ["p1", "", 3, "p2"] }))).toEqual(["p1", "p2"]);
    expect(brandPlanIds(brand({ planIds: "p1" }))).toEqual([]);
  });

  it("reads scripts as three strings whatever is stored", () => {
    expect(brandScripts(null)).toEqual({ head: "", body: "", footer: "" });
    expect(brandScripts(brand({ scripts: { head: " <x> ", body: 4 } }))).toEqual({
      head: "<x>",
      body: "",
      footer: "",
    });
  });

  it("closes the platform's own door and honours a brand's setting", () => {
    // No brand means no tenant for the account to belong to — refused, not
    // filed under the platform.
    expect(brandAllowsSignup(null)).toBe(false);
    expect(brandAllowsSignup(undefined)).toBe(false);
    expect(brandAllowsSignup(brand({ signupMode: "public" }))).toBe(true);
    expect(brandAllowsSignup(brand({ signupMode: "invite" }))).toBe(false);
    // Anything unexpected in the column reads as the safe default: open.
    expect(brandAllowsSignup(brand({ signupMode: "" }))).toBe(true);
  });

  it("returns null card policy when the brand defers to the platform", () => {
    expect(brandCardRequired(null)).toBeNull();
    expect(brandCardRequired(brand({ cardRequired: null }))).toBeNull();
    expect(brandCardRequired(brand({ cardRequired: false }))).toBe(false);
    expect(brandCardRequired(brand({ cardRequired: true }))).toBe(true);
  });
});

describe("normalizeHttpUrl", () => {
  it("adds https to a bare host and strips a trailing slash", () => {
    expect(normalizeHttpUrl("acmevoice.com/", "Website URL")).toBe("https://acmevoice.com");
    expect(normalizeHttpUrl("http://acmevoice.com/terms", "Terms URL")).toBe(
      "http://acmevoice.com/terms",
    );
    expect(normalizeHttpUrl("  ", "Website URL")).toBe("");
  });

  it("refuses anything that isn't a web link — a footer must never carry javascript:", () => {
    expect(() => normalizeHttpUrl("javascript:alert(1)", "Terms URL")).toThrow(/http/);
    expect(() => normalizeHttpUrl("mailto:x@y.z", "Terms URL")).toThrow(/http/);
    expect(() => normalizeHttpUrl("http://", "Terms URL")).toThrow(/valid web address/);
  });
});

describe("resolveSetup", () => {
  it("only returns the keys that were sent, so an update leaves the rest alone", () => {
    expect(resolveSetup({})).toEqual({});
    expect(resolveSetup({ legalName: "  Acme Pty Ltd " })).toEqual({ legalName: "Acme Pty Ltd" });
  });

  it("normalises country and timezone, and rejects the malformed", () => {
    expect(resolveSetup({ defaultCountry: "au", defaultTimezone: "Australia/Sydney" })).toEqual({
      defaultCountry: "AU",
      defaultTimezone: "Australia/Sydney",
    });
    expect(resolveSetup({ defaultCountry: "", defaultTimezone: "" })).toEqual({
      defaultCountry: "",
      defaultTimezone: "",
    });
    expect(() => resolveSetup({ defaultCountry: "AUS" })).toThrow(/two-letter/);
    expect(() => resolveSetup({ defaultTimezone: "Mars/Olympus" })).toThrow(/timezone/);
  });

  it("accepts only the two sign-up modes", () => {
    expect(resolveSetup({ signupMode: "invite" })).toEqual({ signupMode: "invite" });
    expect(() => resolveSetup({ signupMode: "closed" })).toThrow(/Sign-up mode/);
  });

  it("stores every module explicitly, unknown keys dropped", () => {
    const out = resolveSetup({ modules: { booking: false, bogus: true } as never });
    expect(out.modules).toEqual({
      booking: false,
      transfer: true,
      crm: true,
      smsToCaller: true,
      whatsapp: true,
    });
  });

  it("dedupes plan ids and drops blanks", () => {
    expect(resolveSetup({ planIds: ["p1", " p1 ", "", "p2"] }).planIds).toEqual(["p1", "p2"]);
    expect(resolveSetup({ planIds: null }).planIds).toEqual([]);
  });

  it("treats blank trial overrides as 'use the platform' and bounds the rest", () => {
    expect(resolveSetup({ trialDays: null, trialMinutes: null, cardRequired: null })).toEqual({
      trialDays: null,
      trialMinutes: null,
      cardRequired: null,
    });
    expect(resolveSetup({ trialDays: 21, trialMinutes: 30, cardRequired: false })).toEqual({
      trialDays: 21,
      trialMinutes: 30,
      cardRequired: false,
    });
    expect(() => resolveSetup({ trialDays: 400 })).toThrow(/Trial days/);
    expect(() => resolveSetup({ trialMinutes: 1.5 })).toThrow(/Trial minutes/);
  });

  it("caps scripts and always writes all three slots", () => {
    const out = resolveSetup({ scripts: { head: "x".repeat(25_000) } });
    const scripts = out.scripts as { head: string; body: string; footer: string };
    expect(scripts.head).toHaveLength(20_000);
    expect(scripts.body).toBe("");
    expect(scripts.footer).toBe("");
  });
});
