import { tenantForUser } from "../tenantDb.js";
import { endTrialNow } from "../stripe.js";

/** Injected collaborators for enforceTrialMinutes so tests pass a plain object instead of vi.mock-ing tenantDb/stripe. Deliberately narrow pilot; the rest of billing.ts keeps plain imports. */
export interface BillingDeps {
  tenantForUser: typeof tenantForUser;
  endTrialNow: typeof endTrialNow;
}

/** Wires the real singletons — the only place in this pilot that still does. */
export function createBillingDeps(): BillingDeps {
  return { tenantForUser, endTrialNow };
}
