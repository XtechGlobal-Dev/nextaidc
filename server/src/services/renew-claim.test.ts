import { describe, it, expect, vi, beforeEach } from "vitest";

// Early renewal must charge EXACTLY ONCE. Parallel dashboard requests each read
// "exhausted" and each charged the card; fix is an atomic updateMany claim before Stripe.

vi.mock("../prisma.js", () => ({
  prisma: { profile: { findUnique: vi.fn(), update: vi.fn(), updateMany: vi.fn() } },
}));
// The profile lives in the customer's brand's database — the same stand-in here —
// and the plan a test embeds on the row stands in for the catalogue join.
vi.mock("./tenantDb.js", async () => {
  const { prisma } = await import("../prisma.js");
  class TenantUnavailableError extends Error {}
  return { tenantForUser: async () => prisma, TenantUnavailableError };
});
vi.mock("./planLookup.js", () => ({ withPlan: async (p: unknown) => p, withPlans: async (p: unknown) => p }));
vi.mock("./billing.js", () => ({
  getTrialDays: vi.fn(async () => 14),
  getTrialMinutes: vi.fn(async () => 10),
}));
vi.mock("./settings.js", () => ({ integrationsStatus: vi.fn(() => ({ stripe: true })) }));
vi.mock("./stripe.js", () => ({
  isStripeConfigured: vi.fn(() => true),
  endTrialNow: vi.fn(),
  getSubscription: vi.fn(),
  getSubscriptionAutoRenew: vi.fn(async () => true),
  getLatestPaidInvoice: vi.fn(async () => null),
  renewSubscriptionNow: vi.fn(),
}));
vi.mock("./email.js", () => ({ planActivatedEmail: vi.fn(), usageThresholdEmail: vi.fn() }));
vi.mock("./notifications.js", () => ({ notify: vi.fn() }));
vi.mock("./commission.js", () => ({ accrueCommissionForInvoice: vi.fn() }));

import { prisma } from "../prisma.js";
/** The stand-in above, typed as what it is: mocks by model and method. */
const fake = prisma as unknown as Record<string, Record<string, ReturnType<typeof vi.fn>>>;
import { renewSubscriptionNow } from "./stripe.js";
import { reconcileSubscription } from "./trial.js";

const findUnique = fake.profile.findUnique as unknown as ReturnType<typeof vi.fn>;
const update = fake.profile.update as unknown as ReturnType<typeof vi.fn>;
const updateMany = fake.profile.updateMany as unknown as ReturnType<typeof vi.fn>;
const renewNow = renewSubscriptionNow as unknown as ReturnType<typeof vi.fn>;

const NOW = new Date("2026-07-23T07:18:00.000Z");

/** An active plan that has burned every included minute (200/200). */
const exhausted = (over: Record<string, unknown> = {}) => ({
  subscriptionStatus: "active",
  stripeSubscriptionId: "sub_1",
  autoRenew: true,
  trialSecondsUsed: 0,
  trialMinutesAllocated: null,
  planMinutesAllocated: 200,
  planSecondsUsed: 200 * 60,
  currentPeriodEnd: new Date("2026-08-23T00:00:00.000Z"),
  subscriptionPlan: { includedMinutes: 200, displayName: "PREMIUM" },
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  update.mockResolvedValue({});
  findUnique.mockResolvedValue(exhausted());
  renewNow.mockResolvedValue({
    currentPeriodEnd: Math.floor(new Date("2026-09-23T00:00:00.000Z").getTime() / 1000),
    active: true,
    releasedScheduleId: null,
  });
});

describe("early renewal — must charge exactly once", () => {
  it("claims the renewal atomically before charging Stripe", async () => {
    updateMany.mockResolvedValue({ count: 1 });

    await reconcileSubscription("u1", NOW);

    // The claim is a conditional update guarded on usage still being exhausted.
    const claim = updateMany.mock.calls[0][0];
    expect(claim.where.planSecondsUsed).toEqual({ gte: 200 * 60 });
    expect(claim.data.planSecondsUsed).toBe(0);
    // …and it must happen BEFORE the card is touched.
    expect(updateMany.mock.invocationCallOrder[0]).toBeLessThan(
      renewNow.mock.invocationCallOrder[0],
    );
    expect(renewNow).toHaveBeenCalledTimes(1);
  });

  it("does NOT charge when another concurrent request already claimed the cycle", async () => {
    updateMany.mockResolvedValue({ count: 0 }); // lost the race

    await reconcileSubscription("u1", NOW);

    expect(renewNow).not.toHaveBeenCalled();
  });

  it("only one of several parallel reconciles reaches Stripe", async () => {
    // One winner, the rest lose — exactly what Postgres does with the row lock.
    let first = true;
    updateMany.mockImplementation(async () => {
      const won = first;
      first = false;
      return { count: won ? 1 : 0 };
    });

    await Promise.all([
      reconcileSubscription("u1", NOW),
      reconcileSubscription("u1", NOW),
      reconcileSubscription("u1", NOW),
      reconcileSubscription("u1", NOW),
    ]);

    expect(renewNow).toHaveBeenCalledTimes(1);
  });

  it("never claims when minutes are not exhausted", async () => {
    findUnique.mockResolvedValue(exhausted({ planSecondsUsed: 100 * 60 }));

    await reconcileSubscription("u1", NOW);

    expect(updateMany).not.toHaveBeenCalled();
    expect(renewNow).not.toHaveBeenCalled();
  });

  it("never claims when auto-renew is off", async () => {
    findUnique.mockResolvedValue(exhausted({ autoRenew: false }));

    await reconcileSubscription("u1", NOW);

    expect(updateMany).not.toHaveBeenCalled();
    expect(renewNow).not.toHaveBeenCalled();
  });
});
