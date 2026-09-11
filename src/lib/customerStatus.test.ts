import { describe, it, expect } from "vitest";
import type { Customer } from "@/lib/api";
import { statusKey, planLabel, STATUS_META, STATUS_ORDER } from "./customerStatus";

/* Three different customers all carry subscriptionStatus "none": someone who
 * never finished signing up, someone on the card-less free trial, and someone
 * whose trial ran out without ever buying. Telling them apart is the whole
 * point of this — and it's what the admin means by "dead" users. */

const customer = (over: Partial<Customer> = {}): Customer =>
  ({
    id: "u1",
    email: "a@b.com",
    fullName: "Ada",
    role: "USER",
    businessName: "Acme",
    plan: "free",
    numberActivated: false,
    subscriptionStatus: "none",
    onboarding: false,
    freeTrial: false,
    suspended: false,
    planName: null,
    planPriceCents: 0,
    planInterval: "month",
    vapiAssistantId: null,
    callCount: 0,
    createdAt: "2026-07-01T00:00:00.000Z",
    emailOptOutAt: null,
    online: false,
    ...over,
  }) as Customer;

describe("statusKey", () => {
  it("separates the three 'none' customers from each other", () => {
    expect(statusKey(customer({ onboarding: true }))).toBe("onboarding");
    expect(statusKey(customer({ freeTrial: true }))).toBe("trial");
    // Finished onboarding, trial over, never subscribed — the dead-lead bucket.
    expect(statusKey(customer())).toBe("no_plan");
  });

  it("reads the paid states off subscriptionStatus", () => {
    expect(statusKey(customer({ subscriptionStatus: "active" }))).toBe("active");
    expect(statusKey(customer({ subscriptionStatus: "trialing" }))).toBe("trial");
    expect(statusKey(customer({ subscriptionStatus: "past_due" }))).toBe("past_due");
    expect(statusKey(customer({ subscriptionStatus: "canceled" }))).toBe("canceled");
  });

  it("lets an admin lock outrank every billing state", () => {
    expect(statusKey(customer({ suspended: true, subscriptionStatus: "active" }))).toBe("suspended");
    expect(statusKey(customer({ suspended: true, onboarding: true }))).toBe("suspended");
  });

  it("lets onboarding outrank the trial flag", () => {
    // Both can't truly be set, but the order must be deterministic if they are.
    expect(statusKey(customer({ onboarding: true, freeTrial: true }))).toBe("onboarding");
  });

  it("falls back to no_plan for an unrecognised status rather than throwing", () => {
    expect(statusKey(customer({ subscriptionStatus: "something_new" }))).toBe("no_plan");
  });
});

describe("planLabel", () => {
  it("uses the subscription plan's name", () => {
    expect(planLabel(customer({ planName: "STARTER" }))).toBe("STARTER");
  });

  it("buckets everyone without a paid plan under one label", () => {
    expect(planLabel(customer({ planName: null }))).toBe("Free");
    // A whitespace-only name would otherwise become a blank filter option.
    expect(planLabel(customer({ planName: "   " }))).toBe("Free");
  });
});

describe("STATUS_ORDER", () => {
  it("covers every status exactly once, so the filter can't omit one", () => {
    expect([...STATUS_ORDER].sort()).toEqual(Object.keys(STATUS_META).sort());
    expect(new Set(STATUS_ORDER).size).toBe(STATUS_ORDER.length);
  });
});
