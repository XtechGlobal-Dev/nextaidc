import { describe, expect, it } from "vitest";
import { isProviderInUse } from "./apiCenter.js";

/* ------------------------------------------------------------------ *
 *  Which providers a given environment actually uses.
 *
 *  This rule decides what the Providers table shows by default, so both of its
 *  failure modes are user-visible: too loose and every environment lists two
 *  dozen vendors it will never call; too tight and a provider disappears from
 *  the dashboard at the exact moment its credentials break.
 * ------------------------------------------------------------------ */

const base = { wired: true, connected: false, requests: 0, lastRequestAt: null as Date | null };

describe("isProviderInUse", () => {
  it("excludes vendors the code never calls, however they're configured", () => {
    // A roadmap entry in the registry: no call site, so it can have no status.
    expect(isProviderInUse({ ...base, wired: false })).toBe(false);
    expect(isProviderInUse({ ...base, wired: false, connected: true })).toBe(false);
    expect(isProviderInUse({ ...base, wired: false, requests: 500 })).toBe(false);
  });

  it("includes a wired provider as soon as credentials are held, before any traffic", () => {
    // Freshly configured and not yet called — it belongs on the dashboard, since
    // the next call is expected to go somewhere.
    expect(isProviderInUse({ ...base, connected: true })).toBe(true);
  });

  it("excludes a wired provider this environment has neither configured nor called", () => {
    // The case the whole rule exists for: a local box that only ever uses OpenAI
    // shouldn't list Twilio, Deepgram and WhatsApp as permanently-red rows.
    expect(isProviderInUse(base)).toBe(false);
  });

  it("keeps showing a provider whose credentials were removed but which has history", () => {
    // The dangerous direction. Losing a key makes `connected` false; if that
    // alone hid the row, the integration would vanish precisely when it broke.
    expect(isProviderInUse({ ...base, connected: false, lastRequestAt: new Date("2026-08-01") })).toBe(true);
  });

  it("counts traffic in the current window even when history has aged out", () => {
    expect(isProviderInUse({ ...base, requests: 3 })).toBe(true);
  });

  it("does not depend on the selected time range", () => {
    // Switching the range to "1h" zeroes `requests` for a quiet provider. It must
    // stay listed on the strength of its recorded history, or half the fleet
    // would blink out of existence on a range change.
    const quietThisHour = { ...base, requests: 0, lastRequestAt: new Date("2026-07-20") };
    expect(isProviderInUse(quietThisHour)).toBe(true);
  });
});
