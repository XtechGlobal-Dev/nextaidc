import { describe, it, expect, vi, beforeEach } from "vitest";

// Go-live charge: a failed charge must NOT destroy the trial — the account stays
// trialing so the user can retry after fixing their card.

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
  getTrialMinutes: vi.fn(async () => 5),
}));
vi.mock("./settings.js", () => ({ integrationsStatus: vi.fn(() => ({ stripe: true })) }));
vi.mock("./stripe.js", () => ({
  isStripeConfigured: vi.fn(() => true),
  endTrialNow: vi.fn(),
  getSubscription: vi.fn(),
  getSubscriptionAutoRenew: vi.fn(),
  setSubscriptionAutoRenew: vi.fn(),
  getLatestPaidInvoice: vi.fn(async () => null),
  renewSubscriptionNow: vi.fn(),
}));
vi.mock("./email.js", () => ({ planActivatedEmail: vi.fn(), usageThresholdEmail: vi.fn() }));
vi.mock("./notifications.js", () => ({ notify: vi.fn() }));
vi.mock("./commission.js", () => ({ accrueCommissionForInvoice: vi.fn() }));
vi.mock("./planHistory.js", () => ({ recordPlanEvent: vi.fn() }));

import { prisma } from "../prisma.js";
/** The stand-in above, typed as what it is: mocks by model and method. */
const fake = prisma as unknown as Record<string, Record<string, ReturnType<typeof vi.fn>>>;
import { endTrialNow, getSubscription, setSubscriptionAutoRenew } from "./stripe.js";
import { chargeTrialAndActivateNow } from "./trial.js";

const findUnique = fake.profile.findUnique as unknown as ReturnType<typeof vi.fn>;
const update = fake.profile.update as unknown as ReturnType<typeof vi.fn>;
const endTrial = endTrialNow as unknown as ReturnType<typeof vi.fn>;
const getSub = getSubscription as unknown as ReturnType<typeof vi.fn>;
const setAutoRenew = setSubscriptionAutoRenew as unknown as ReturnType<typeof vi.fn>;

const trialingProfile = (over: Record<string, unknown> = {}) => ({
  subscriptionStatus: "trialing",
  stripeSubscriptionId: "sub_1",
  subscriptionPlanId: "plan_1",
  trialSecondsUsed: 0,
  trialMinutesAllocated: 5,
  subscriptionPlan: { includedMinutes: 200, displayName: "Standard" },
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  update.mockResolvedValue({});
  (fake.profile.updateMany as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({ count: 1 });
});

describe("chargeTrialAndActivateNow", () => {
  it("no-ops for a user who isn't trialing — never touches Stripe", async () => {
    findUnique.mockResolvedValue(trialingProfile({ subscriptionStatus: "active" }));

    const res = await chargeTrialAndActivateNow("u1");

    expect(res.converted).toBe(false);
    expect(setAutoRenew).not.toHaveBeenCalled();
    expect(endTrial).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
  });

  it("no-ops for a card-less trial (no Stripe subscription)", async () => {
    findUnique.mockResolvedValue(trialingProfile({ stripeSubscriptionId: null }));

    const res = await chargeTrialAndActivateNow("u1");

    expect(res.converted).toBe(false);
    expect(endTrial).not.toHaveBeenCalled();
  });

  it("ends the trial atomically (errorIfIncomplete) so a decline can't destroy it", async () => {
    findUnique.mockResolvedValue(trialingProfile());
    getSub.mockResolvedValue({ status: "trialing", currentPeriodEnd: null });
    endTrial.mockRejectedValue(new Error("Your card was declined."));

    await expect(chargeTrialAndActivateNow("u1")).rejects.toMatchObject({ status: 400 });

    // The atomic flag is what keeps the trial alive on a failed charge.
    expect(endTrial).toHaveBeenCalledWith("sub_1", { errorIfIncomplete: true });
    // A charge failure must NOT flip the account to past_due — the trial survives
    // and the user can retry after fixing their card.
    expect(update).not.toHaveBeenCalled();
  });

  it("surfaces a card-specific message when the charge is declined", async () => {
    findUnique.mockResolvedValue(trialingProfile());
    getSub.mockResolvedValue({ status: "trialing", currentPeriodEnd: null });
    endTrial.mockRejectedValue(new Error("card_declined"));

    await expect(chargeTrialAndActivateNow("u1")).rejects.toThrow(/card/i);
  });

  it("throws if the subscription doesn't end up active after ending the trial", async () => {
    findUnique.mockResolvedValue(trialingProfile());
    // Card needs authentication → stays past_due, never reaches active.
    getSub.mockResolvedValueOnce({ status: "trialing", currentPeriodEnd: null });
    endTrial.mockResolvedValue(undefined);
    getSub.mockResolvedValueOnce({ status: "past_due", currentPeriodEnd: null });

    await expect(chargeTrialAndActivateNow("u1")).rejects.toMatchObject({ status: 400 });
    expect(update).not.toHaveBeenCalled();
  });
});
