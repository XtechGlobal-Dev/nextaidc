import { describe, it, expect } from "vitest";
import { normalizeSmsInfoItems, normalizeAutomations } from "./agentConfig.js";
import {
  MAX_ENABLED_SMS_INFO_ITEMS,
  MAX_SMS_INFO_ITEMS,
  SEEDED_SMS_INFO_ITEMS,
} from "./smsInfoItems.js";

/* The server is the authority on how many details may be ENABLED — a client
 * bypassing the UI must not be able to switch on a fourth or bloat the list. */

describe("normalizeSmsInfoItems (server authority)", () => {
  it("falls back to the seeded catalogue when the list is absent", () => {
    expect(normalizeSmsInfoItems(undefined).map((i) => i.key)).toEqual(
      SEEDED_SMS_INFO_ITEMS.map((i) => i.key),
    );
  });

  it("caps enabled rows at the limit, pausing extras but keeping them", () => {
    const many = Array.from({ length: 5 }, (_, n) => ({ key: `k${n}`, template: `t${n}`, enabled: true }));
    const out = normalizeSmsInfoItems(many);
    expect(out.filter((i) => i.enabled)).toHaveLength(MAX_ENABLED_SMS_INFO_ITEMS);
    expect(out.length).toBe(5);
  });

  it("bounds the total stored rows", () => {
    const tooMany = Array.from({ length: 30 }, (_, n) => ({ key: `k${n}`, template: `t${n}`, enabled: false }));
    expect(normalizeSmsInfoItems(tooMany).length).toBeLessThanOrEqual(MAX_SMS_INFO_ITEMS);
  });

  it("respects an owner who deliberately cleared the list", () => {
    expect(normalizeSmsInfoItems([])).toEqual([]);
  });

  it("drops rows with no key or no template", () => {
    expect(normalizeSmsInfoItems([{ key: "", template: "x" }, { key: "a", template: "" }])).toEqual([]);
  });
});

describe("normalizeAutomations wires the SMS catalogue through", () => {
  it("seeds the catalogue for a legacy config", () => {
    const a = normalizeAutomations({ summaryEmail: "x@y.com" });
    expect(a.smsOnRequest.items.map((i) => i.key)).toEqual(SEEDED_SMS_INFO_ITEMS.map((i) => i.key));
  });

  it("enforces the enabled cap on whatever was stored", () => {
    const a = normalizeAutomations({
      summaryEmail: "x@y.com",
      smsOnRequest: {
        items: [
          { key: "a", template: "1", enabled: true },
          { key: "b", template: "2", enabled: true },
          { key: "c", template: "3", enabled: true },
          { key: "d", template: "4", enabled: true },
        ],
      },
    });
    expect(a.smsOnRequest.items.filter((i) => i.enabled)).toHaveLength(MAX_ENABLED_SMS_INFO_ITEMS);
  });
});
