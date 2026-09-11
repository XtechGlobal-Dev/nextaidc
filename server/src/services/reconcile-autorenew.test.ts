import { describe, it, expect, vi, beforeEach } from "vitest";

// reconcileSubscription's active-plan renewal path is where a "cancelled but
// still auto-recharged" bug lived: the early minutes-exhausted renewal must NOT
// fire once the user has cancelled — whether the local autoRenew flag caught up
// (via the webhook) or is stale (webhook not yet landed → live Stripe says so).

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
vi.mock("./settings.js", () => ({
  integrationsStatus: vi.fn(() => ({ stripe: true })),
}));
vi.mock("./stripe.js", () => ({
  isStripeConfigured: vi.fn(() => true),
  endTrialNow: vi.fn(),
  getSubscription: vi.fn(),
  getSubscriptionAutoRenew: vi.fn(),
  getLatestPaidInvoice: vi.fn(async () => null),
  renewSubscriptionNow: vi.fn(),
}));
vi.mock("./email.js", () => ({ planActivatedEmail: vi.fn(), usageThresholdEmail: vi.fn() }));
vi.mock("./notifications.js", () => ({ notify: vi.fn() }));
vi.mock("./commission.js", () => ({ accrueCommissionForInvoice: vi.fn() }));

import { prisma } from "../prisma.js";
/** The stand-in above, typed as what it is: mocks by model and method. */
const fake = prisma as unknown as Record<string, Record<string, ReturnType<typeof vi.fn>>>;
import { getSubscriptionAutoRenew, renewSubscriptionNow } from "./stripe.js";
import { reconcileSubscription } from "./trial.js";

const findUnique = fake.profile.findUnique as unknown as ReturnType<typeof vi.fn>;
const update = fake.profile.update as unknown as ReturnType<typeof vi.fn>;
const liveAutoRenew = getSubscriptionAutoRenew as unknown as ReturnType<typeof vi.fn>;
const renewNow = renewSubscriptionNow as unknown as ReturnType<typeof vi.fn>;

const NOW = new Date("2026-07-02T00:00:00.000Z");

// An active plan that has burned through every included minute (5/5 used).
const exhaustedActive = (over: Record<string, unknown> = {}) => ({
  subscriptionStatus: "active",
  stripeSubscriptionId: "sub_1",
  autoRenew: true,
  trialSecondsUsed: 0,
  trialMinutesAllocated: null,
  planMinutesAllocated: 5,
  planSecondsUsed: 5 * 60,
  subscriptionPlan: { includedMinutes: 5, displayName: "Starter" },
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  update.mockResolvedValue({});
  // The early renewal now claims the cycle atomically before charging; this test
  // file is about WHETHER it renews, so let the claim always succeed.
  (fake.profile.updateMany as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({ count: 1 });
});

describe("reconcileSubscription — cancelled plan must not auto-recharge", () => {
  it("does NOT renew when the local autoRenew flag is already off (webhook synced the portal cancel)", async () => {
    findUnique.mockResolvedValue(exhaustedActive({ autoRenew: false }));

    await reconcileSubscription("u1", NOW);

    expect(liveAutoRenew).not.toHaveBeenCalled();
    expect(renewNow).not.toHaveBeenCalled();
  });

  it("does NOT renew when the local flag is stale-true but Stripe says the sub is set to cancel", async () => {
    // The portal cancel happened; its webhook hasn't landed, so the DB still says
    // autoRenew=true. The live Stripe read is the safety net.
    findUnique.mockResolvedValue(exhaustedActive({ autoRenew: true }));
    liveAutoRenew.mockResolvedValue(false);

    await reconcileSubscription("u1", NOW);

    expect(liveAutoRenew).toHaveBeenCalledWith("sub_1");
    expect(renewNow).not.toHaveBeenCalled();
    // and it heals the stale flag so the UI stops showing auto-renew "On".
    expect(update).toHaveBeenCalledWith({ where: { userId: "u1" }, data: { autoRenew: false } });
  });

  it("DOES renew when auto-renew is genuinely still on (not cancelled)", async () => {
    findUnique.mockResolvedValue(exhaustedActive({ autoRenew: true }));
    liveAutoRenew.mockResolvedValue(true);
    renewNow.mockResolvedValue({ currentPeriodEnd: NOW.getTime() / 1000 + 30 * 86400, active: true });

    await reconcileSubscription("u1", NOW);

    expect(renewNow).toHaveBeenCalledWith("sub_1", { dedupeConcurrent: true });
  });

  it("renews (fail-open) if the live Stripe read throws — a transient read must not block a legit renewal", async () => {
    findUnique.mockResolvedValue(exhaustedActive({ autoRenew: true }));
    liveAutoRenew.mockRejectedValue(new Error("stripe timeout"));
    renewNow.mockResolvedValue({ currentPeriodEnd: NOW.getTime() / 1000 + 30 * 86400, active: true });

    await reconcileSubscription("u1", NOW);

    expect(renewNow).toHaveBeenCalledWith("sub_1", { dedupeConcurrent: true });
  });
});
