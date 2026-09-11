import { describe, it, expect, vi, beforeEach } from "vitest";

/* ------------------------------------------------------------------ *
 *  A queued downgrade must not quietly cancel a customer's coupon.
 *
 *  scheduleDowngrade writes the schedule's phases explicitly, and Stripe treats
 *  a phase's `discounts` as "if not specified, inherit from the subscription's
 *  CUSTOMER". Our coupons live on the subscription, not the customer — so
 *  phases written without `discounts` strip the discount the moment the
 *  schedule takes over. Nothing errors; the customer just starts paying full
 *  price with cycles still owed, which is the sort of bug you find in a refund
 *  request months later.
 * ------------------------------------------------------------------------- */

const subscriptions = { retrieve: vi.fn(), update: vi.fn() };
const subscriptionSchedules = { create: vi.fn(), update: vi.fn(), release: vi.fn() };

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

import { scheduleDowngrade } from "./stripe.js";

const PERIOD_END = 1_800_000_000;

const sub = (discounts: unknown[] = []) => ({
  id: "sub_1",
  status: "active",
  current_period_end: PERIOD_END,
  items: { data: [{ id: "si_1", price: { id: "price_premium" } }] },
  discounts,
});

beforeEach(() => {
  vi.clearAllMocks();
  subscriptionSchedules.create.mockResolvedValue({
    id: "sub_sched_1",
    phases: [{ start_date: 1_700_000_000 }],
  });
  subscriptionSchedules.update.mockResolvedValue({});
});

/** The phases handed to Stripe by the last scheduleDowngrade call. */
const writtenPhases = () => subscriptionSchedules.update.mock.calls[0][1].phases;

describe("scheduleDowngrade", () => {
  it("carries a live coupon onto BOTH phases", async () => {
    subscriptions.retrieve.mockResolvedValue(sub([{ coupon: { id: "co_launch30" } }]));

    await scheduleDowngrade("sub_1", "price_starter");

    const [current, downgraded] = writtenPhases();
    expect(current.discounts).toEqual([{ coupon: "co_launch30" }]);
    // The cheaper phase too: a coupon is a number of billing CYCLES, not a
    // plan, so cycles bought before the downgrade are still owed after it.
    expect(downgraded.discounts).toEqual([{ coupon: "co_launch30" }]);
  });

  it("asks Stripe to expand discounts — an unexpanded id can't be read", async () => {
    subscriptions.retrieve.mockResolvedValue(sub([{ coupon: { id: "co_launch30" } }]));
    await scheduleDowngrade("sub_1", "price_starter");
    expect(subscriptions.retrieve).toHaveBeenCalledWith("sub_1", { expand: ["discounts"] });
  });

  it("reads a coupon given as a bare id string", async () => {
    subscriptions.retrieve.mockResolvedValue(sub([{ coupon: "co_launch30" }]));
    await scheduleDowngrade("sub_1", "price_starter");
    expect(writtenPhases()[0].discounts).toEqual([{ coupon: "co_launch30" }]);
  });

  it("sends no `discounts` key at all when there's no coupon", async () => {
    subscriptions.retrieve.mockResolvedValue(sub([]));

    await scheduleDowngrade("sub_1", "price_starter");

    // Not `discounts: []` — that would be an explicit "no discounts" write, and
    // there is nothing to say here.
    for (const phase of writtenPhases()) expect(phase).not.toHaveProperty("discounts");
  });

  it("still writes the two phases and the release behaviour", async () => {
    subscriptions.retrieve.mockResolvedValue(sub([{ coupon: { id: "co_x" } }]));

    const { scheduleId, effectiveAt } = await scheduleDowngrade("sub_1", "price_starter");

    const [id, params] = subscriptionSchedules.update.mock.calls[0];
    expect(id).toBe("sub_sched_1");
    expect(params.end_behavior).toBe("release");
    expect(params.phases[0].items).toEqual([{ price: "price_premium", quantity: 1 }]);
    expect(params.phases[0].end_date).toBe(PERIOD_END);
    expect(params.phases[1].items).toEqual([{ price: "price_starter", quantity: 1 }]);
    expect(scheduleId).toBe("sub_sched_1");
    expect(effectiveAt).toBe(PERIOD_END);
  });
});
