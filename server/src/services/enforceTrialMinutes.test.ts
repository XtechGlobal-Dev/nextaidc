import { describe, it, expect, vi } from "vitest";

// getTrialMinutes() is same-module (not in BillingDeps) and reads prisma + the
// brand cache directly, so stub those.
vi.mock("../prisma.js", () => ({ prisma: { platformSetting: { findUnique: vi.fn().mockResolvedValue(null) } } }));
vi.mock("./brands.js", () => ({ cachedBrand: () => null }));

import { enforceTrialMinutes } from "./billing.js";
import type { BillingDeps } from "./billing/deps.js";

// Module-boundary pilot: enforceTrialMinutes takes its collaborators as an explicit
// `deps` object (billing/deps.ts), so no vi.mock of tenantDb/stripe is needed here.

function fakeDeps(overrides: Partial<BillingDeps> = {}): BillingDeps {
  return {
    tenantForUser: vi.fn(),
    endTrialNow: vi.fn(),
    ...overrides,
  } as BillingDeps;
}

describe("enforceTrialMinutes", () => {
  it("does nothing for a profile that isn't trialing", async () => {
    const findUnique = vi.fn().mockResolvedValue({
      subscriptionStatus: "active",
      stripeSubscriptionId: "sub_1",
      autoRenew: true,
    });
    const deps = fakeDeps({
      tenantForUser: vi.fn().mockResolvedValue({ profile: { findUnique } } as never),
    });

    await enforceTrialMinutes("user_1", deps);
    expect(deps.endTrialNow).not.toHaveBeenCalled();
  });

  it("never auto-charges a trialing profile with auto-renew off", async () => {
    const findUnique = vi.fn().mockResolvedValue({
      subscriptionStatus: "trialing",
      stripeSubscriptionId: "sub_1",
      autoRenew: false,
    });
    const deps = fakeDeps({
      tenantForUser: vi.fn().mockResolvedValue({ profile: { findUnique } } as never),
    });

    await enforceTrialMinutes("user_1", deps);
    expect(deps.endTrialNow).not.toHaveBeenCalled();
  });

  it("ends the trial once usage reaches the quota", async () => {
    const profile = {
      subscriptionStatus: "trialing",
      stripeSubscriptionId: "sub_1",
      autoRenew: true,
    };
    const update = vi.fn();
    const db = {
      profile: { findUnique: vi.fn().mockResolvedValue(profile), update },
      conversion: { findUnique: vi.fn().mockResolvedValue({ id: "conv_1" }) },
      callLog: { aggregate: vi.fn().mockResolvedValue({ _sum: { durationSec: 20 * 60 } }) },
    };
    const deps = fakeDeps({ tenantForUser: vi.fn().mockResolvedValue(db as never) });

    await enforceTrialMinutes("user_1", deps);

    expect(deps.endTrialNow).toHaveBeenCalledWith("sub_1");
    expect(update).toHaveBeenCalledWith({
      where: { userId: "user_1" },
      data: { subscriptionStatus: "active", trialEndsAt: null },
    });
  });
});
