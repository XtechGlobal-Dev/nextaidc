import { describe, it, expect, vi, beforeEach } from "vitest";
import qs from "qs";

// Clearing a Stripe list param is a wire-format trap, and it fails SILENTLY.
//
// Stripe's API is form-encoded and stripe-node runs params through
// `qs.stringify`, which emits nothing at all for an empty array. So
// `subscriptions.update(id, { discounts: [] })` posted an entirely empty body —
// a successful no-op that left the coupon attached. A 2-cycle coupon therefore
// discounted every invoice forever: our own bookkeeping retired the redemption
// on time, the detach reported success, and Stripe never heard about it.
//
// Nothing threw, so no error path could catch it — which is why these tests
// assert the ENCODED request rather than just the argument. Asserting
// `{ discounts: "" }` alone would still pass if someone "simplified" it back to
// `[]` at some other layer; asserting that the encoded body actually carries a
// `discounts` key is what pins the behaviour that matters.

const subscriptions = { retrieve: vi.fn(), update: vi.fn() };
const subscriptionSchedules = { retrieve: vi.fn(), update: vi.fn() };

vi.mock("stripe", () => ({
  default: class {
    subscriptions = subscriptions;
    subscriptionSchedules = subscriptionSchedules;
  },
}));
vi.mock("../env.js", () => ({
  // Brand hosts resolve against these; the real module exports them, so a
  // mock that omits them fails to link for anything importing brandUrls.
  platformDomain: "hello22.ai",
  platformDomains: ["hello22.ai"],
  allowUnverifiedBrandDomains: false,
  canonicalApiBaseUrl: "https://api.test",
  env: { STRIPE_SECRET_KEY: "sk_test_fake", STRIPE_WEBHOOK_SECRET: "" },
}));

import {
  attachSubscriptionDiscount,
  detachSubscriptionDiscount,
  setSchedulePhaseDiscounts,
} from "./stripe.js";

/**
 * Exactly how stripe-node serialises a v1 request body — `qs.stringify` with
 * indexed arrays, then the square brackets put back as literals
 * (see `queryStringifyRequestData` in stripe/cjs/utils.js).
 */
function encode(params: unknown): string {
  return qs
    .stringify(params, { arrayFormat: "indices" })
    .replace(/%5B/g, "[")
    .replace(/%5D/g, "]");
}

beforeEach(() => {
  vi.clearAllMocks();
  subscriptions.update.mockResolvedValue({});
  subscriptionSchedules.update.mockResolvedValue({});
});

describe("detachSubscriptionDiscount", () => {
  it("sends a body that actually clears the discount", async () => {
    await detachSubscriptionDiscount("sub_1");

    const [, params] = subscriptions.update.mock.calls[0];
    // The regression: an empty array encodes to "" — Stripe receives no
    // parameter and changes nothing.
    expect(encode(params)).not.toBe("");
    expect(encode(params)).toContain("discounts=");
    expect(params).toEqual({ discounts: "" });
  });

  it("does not use an empty array, which the form encoder drops", () => {
    expect(encode({ discounts: [] })).toBe("");
    expect(encode({ discounts: "" })).toBe("discounts=");
  });
});

describe("attachSubscriptionDiscount", () => {
  it("sends the coupon, replacing whatever was there", async () => {
    await attachSubscriptionDiscount("sub_1", "cpn_abc");

    const [id, params] = subscriptions.update.mock.calls[0];
    expect(id).toBe("sub_1");
    expect(params).toEqual({ discounts: [{ coupon: "cpn_abc" }] });
    expect(encode(params)).toBe("discounts[0][coupon]=cpn_abc");
  });
});

describe("setSchedulePhaseDiscounts", () => {
  const schedule = (over: Record<string, unknown> = {}) => ({
    id: "sub_sched_1",
    status: "active",
    phases: [
      {
        start_date: 2_000_000_000,
        end_date: 2_100_000_000,
        items: [{ price: "price_1", quantity: 1 }],
      },
    ],
    ...over,
  });

  it("clears a retired coupon from the remaining phases", async () => {
    subscriptionSchedules.retrieve.mockResolvedValue(schedule());

    await setSchedulePhaseDiscounts("sub_sched_1", null);

    const [, params] = subscriptionSchedules.update.mock.calls[0];
    expect(params.phases[0].discounts).toBe("");
    // A phase written with `discounts: []` loses the key entirely, so the clear
    // is never stated and the schedule falls back to Stripe's inherit rule.
    expect(encode(params)).toContain("phases[0][discounts]=");
  });

  it("restates a live coupon on the remaining phases", async () => {
    subscriptionSchedules.retrieve.mockResolvedValue(schedule());

    await setSchedulePhaseDiscounts("sub_sched_1", "cpn_abc");

    const [, params] = subscriptionSchedules.update.mock.calls[0];
    expect(params.phases[0].discounts).toEqual([{ coupon: "cpn_abc" }]);
  });

  it("leaves a released schedule alone", async () => {
    subscriptionSchedules.retrieve.mockResolvedValue(schedule({ status: "released" }));

    await setSchedulePhaseDiscounts("sub_sched_1", null);

    expect(subscriptionSchedules.update).not.toHaveBeenCalled();
  });
});
