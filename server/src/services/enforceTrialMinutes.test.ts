import { describe, it, expect, vi } from "vitest";

// enforceTrialMinutes calls the SAME-module getTrialMinutes() internally
// (not part of BillingDeps — see billing/deps.ts's own note on scope), which
// reads the shared `prisma` singleton and brands.js's cache directly, same as
// every other service. Stubbed here so that call resolves instantly instead
// of reaching the real database.
vi.mock("../prisma.js", () => ({ prisma: { platformSetting: { findUnique: vi.fn().mockResolvedValue(null) } } }));
vi.mock("./brands.js", () => ({ cachedBrand: () => null }));

import { enforceTrialMinutes } from "./billing.js";
import type { BillingDeps } from "./billing/deps.js";

/* ------------------------------------------------------------------ *
 *  Module-boundary pilot: enforceTrialMinutes takes its cross-service
 *  collaborators (tenantForUser, endTrialNow) as an explicit `deps`
 *  parameter (see billing/deps.ts) instead of reading them as ambient
 *  module-scope imports. That means this test hands it a plain object
 *  literal — no `vi.mock("./tenantDb.js", ...)` / `vi.mock("./stripe.js",
 *  ...)` module substitution required, unlike the rest of the codebase's
 *  services (which still use the vi.mock pattern; see tenantDb.ts's own
 *  "ROUTING IS EXPLICIT, NEVER AMBIENT" module, deliberately untouched here).
 *
 *  billing.ts's OTHER exports (getFxRates, getTrialDays, ...) still read
 *  the shared `prisma` singleton directly, same as every other service in
 *  this codebase — this pilot is narrowly scoped to the one function with
 *  genuine cross-service coupling, not a rewrite of the whole file.
 * ------------------------------------------------------------------ */

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
