import { describe, it, expect, vi, beforeEach } from "vitest";

// A subscription attached to a Stripe subscription schedule (a pending downgrade)
// rejects direct writes to its cancelation / billing-cycle fields:
//   "The subscription is managed by the subscription schedule `sub_sched_…`, and
//    updating any cancelation behavior directly is not allowed."
// Both `setSubscriptionAutoRenew` and `renewSubscriptionNow` do exactly such a
// write, so each must release the schedule FIRST. These tests pin that ordering
// and the "leave it alone when there's no schedule" case.

const subscriptions = {
  retrieve: vi.fn(),
  update: vi.fn(),
};
const subscriptionSchedules = { release: vi.fn() };
const paymentMethods = { list: vi.fn(async () => ({ data: [] })) };
const customers = { update: vi.fn() };

vi.mock("stripe", () => ({
  default: class {
    subscriptions = subscriptions;
    subscriptionSchedules = subscriptionSchedules;
    paymentMethods = paymentMethods;
    customers = customers;
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

import { setSubscriptionAutoRenew, renewSubscriptionNow } from "./stripe.js";

/** A live subscription; `schedule` set = a downgrade is queued. */
const sub = (over: Record<string, unknown> = {}) => ({
  id: "sub_1",
  status: "active",
  cancel_at_period_end: false,
  current_period_end: 1_800_000_000,
  schedule: null,
  default_payment_method: "pm_1", // skips the ensure-default-card lookup
  items: { data: [{ id: "si_1", price: { id: "price_premium" } }] },
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  subscriptionSchedules.release.mockResolvedValue({});
  subscriptions.update.mockResolvedValue(sub({ status: "active" }));
});

describe("setSubscriptionAutoRenew — pending downgrade", () => {
  it("releases the schedule before setting cancel_at_period_end, and reports it", async () => {
    subscriptions.retrieve.mockResolvedValue(sub({ schedule: "sub_sched_1" }));

    const { releasedScheduleId } = await setSubscriptionAutoRenew("sub_1", false);

    expect(subscriptionSchedules.release).toHaveBeenCalledWith("sub_sched_1");
    expect(subscriptions.update).toHaveBeenCalledWith("sub_1", { cancel_at_period_end: true });
    // Ordering is the whole point — updating first is the bug being fixed.
    expect(subscriptionSchedules.release.mock.invocationCallOrder[0]).toBeLessThan(
      subscriptions.update.mock.invocationCallOrder[0],
    );
    expect(releasedScheduleId).toBe("sub_sched_1");
  });

  it("handles a schedule given as an expanded object, not just an id string", async () => {
    subscriptions.retrieve.mockResolvedValue(sub({ schedule: { id: "sub_sched_2" } }));

    const { releasedScheduleId } = await setSubscriptionAutoRenew("sub_1", false);

    expect(subscriptionSchedules.release).toHaveBeenCalledWith("sub_sched_2");
    expect(releasedScheduleId).toBe("sub_sched_2");
  });

  it("touches no schedule when none is attached", async () => {
    subscriptions.retrieve.mockResolvedValue(sub());

    const { releasedScheduleId } = await setSubscriptionAutoRenew("sub_1", false);

    expect(subscriptionSchedules.release).not.toHaveBeenCalled();
    expect(subscriptions.update).toHaveBeenCalledWith("sub_1", { cancel_at_period_end: true });
    expect(releasedScheduleId).toBeNull();
  });

  it("re-enabling clears cancel_at_period_end", async () => {
    subscriptions.retrieve.mockResolvedValue(sub({ cancel_at_period_end: true }));

    await setSubscriptionAutoRenew("sub_1", true);

    expect(subscriptions.update).toHaveBeenCalledWith("sub_1", { cancel_at_period_end: false });
  });

  it("is a no-op when already in the requested state — never risks the schedule restriction", async () => {
    subscriptions.retrieve.mockResolvedValue(sub({ cancel_at_period_end: true, schedule: "sub_sched_1" }));

    const { releasedScheduleId } = await setSubscriptionAutoRenew("sub_1", false);

    expect(subscriptions.update).not.toHaveBeenCalled();
    expect(subscriptionSchedules.release).not.toHaveBeenCalled();
    expect(releasedScheduleId).toBeNull();
  });
});

describe("renewSubscriptionNow — pending downgrade", () => {
  it("releases the schedule before re-anchoring the billing cycle", async () => {
    subscriptions.retrieve.mockResolvedValue(sub({ schedule: "sub_sched_1" }));

    const { releasedScheduleId, active } = await renewSubscriptionNow("sub_1");

    expect(subscriptionSchedules.release).toHaveBeenCalledWith("sub_sched_1");
    expect(subscriptions.update).toHaveBeenCalledWith(
      "sub_1",
      {
        billing_cycle_anchor: "now",
        proration_behavior: "none",
        payment_behavior: "error_if_incomplete",
      },
      // Third arg carries request options (idempotency key when deduping).
      expect.any(Object),
    );
    expect(subscriptionSchedules.release.mock.invocationCallOrder[0]).toBeLessThan(
      subscriptions.update.mock.invocationCallOrder[0],
    );
    expect(releasedScheduleId).toBe("sub_sched_1");
    expect(active).toBe(true);
  });

  it("touches no schedule when none is attached", async () => {
    subscriptions.retrieve.mockResolvedValue(sub());

    const { releasedScheduleId } = await renewSubscriptionNow("sub_1");

    expect(subscriptionSchedules.release).not.toHaveBeenCalled();
    expect(releasedScheduleId).toBeNull();
  });
});
