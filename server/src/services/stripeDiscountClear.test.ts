import { describe, it, expect, vi, beforeEach } from "vitest";
import qs from "qs";

// qs emits nothing for an empty array, so `{ discounts: [] }` posted an empty body and a coupon
// "detach" silently did nothing. These tests assert the ENCODED body, not just the argument.

const subscriptions = { retrieve: vi.fn(), update: vi.fn() };
const subscriptionSchedules = { retrieve: vi.fn(), update: vi.fn() };

vi.mock("stripe", () => ({
  default: class {
    subscriptions = subscriptions;
    subscriptionSchedules = subscriptionSchedules;
  },
}));
vi.mock("../env.js", () => ({
  // brandUrls imports these; a mock without them fails to link.
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

// Mirrors stripe-node's `queryStringifyRequestData`: qs with indexed arrays, brackets restored.
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
