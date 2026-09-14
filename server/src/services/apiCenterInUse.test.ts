import { describe, expect, it } from "vitest";
import { isProviderInUse } from "./apiCenter.js";

// Decides what the Providers table shows by default. Too loose lists vendors the env
// never calls; too tight hides a provider at the exact moment its credentials break.

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
    // A "1h" range zeroes `requests` for quiet providers; history must keep them listed
    // or half the fleet blinks out on a range change.
    const quietThisHour = { ...base, requests: 0, lastRequestAt: new Date("2026-07-20") };
    expect(isProviderInUse(quietThisHour)).toBe(true);
  });
});
