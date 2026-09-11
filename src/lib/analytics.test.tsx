import { describe, it, expect, beforeEach } from "vitest";
import { trackEvent } from "./analytics";

/* ------------------------------------------------------------------ *
 *  GTM data layer helper. Verifies events land on window.dataLayer in
 *  the shape GTM expects ({ event, ...params }). Lives as .test.tsx so it
 *  runs under jsdom, where `window` exists (see vitest.config.ts).
 * ------------------------------------------------------------------ */

beforeEach(() => {
  (window as { dataLayer?: unknown[] }).dataLayer = undefined;
});

describe("trackEvent", () => {
  it("initialises dataLayer and pushes the named event", () => {
    trackEvent("generate_ai_receptionist", { website_url: "https://example.com" });

    const dl = (window as { dataLayer?: Record<string, unknown>[] }).dataLayer;
    expect(dl).toHaveLength(1);
    expect(dl![0]).toEqual({
      event: "generate_ai_receptionist",
      website_url: "https://example.com",
    });
  });

  it("appends to an existing dataLayer without clobbering earlier entries", () => {
    (window as { dataLayer?: Record<string, unknown>[] }).dataLayer = [{ event: "gtm.js" }];

    trackEvent("generate_ai_receptionist", { website_url: "https://acme.test" });

    const dl = (window as { dataLayer?: Record<string, unknown>[] }).dataLayer!;
    expect(dl).toHaveLength(2);
    expect(dl[0]).toEqual({ event: "gtm.js" });
    expect(dl[1].event).toBe("generate_ai_receptionist");
  });

  it("defaults params to an empty object", () => {
    trackEvent("some_event");
    const dl = (window as { dataLayer?: Record<string, unknown>[] }).dataLayer!;
    expect(dl[0]).toEqual({ event: "some_event" });
  });
});
