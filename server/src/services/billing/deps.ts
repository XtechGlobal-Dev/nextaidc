import { tenantForUser } from "../tenantDb.js";
import { endTrialNow } from "../stripe.js";

/**
 * Explicit dependencies for billing.ts's enforceTrialMinutes — a narrow pilot
 * of passing cross-service collaborators as a parameter instead of reading
 * them as ambient module-scope imports. A test can now hand enforceTrialMinutes
 * a plain object literal instead of `vi.mock`-ing tenantDb.js/stripe.js wholesale.
 *
 * Deliberately narrow: the rest of billing.ts (FX helpers, trial-terms lookups)
 * stays on plain imports of the shared `prisma` singleton — that's the same
 * convention every other service in this codebase already follows, and isn't
 * the coupling this pilot is about. tenantDb.ts's own routing internals
 * (its "ROUTING IS EXPLICIT, NEVER AMBIENT" registry/pooling) are untouched;
 * this only changes how enforceTrialMinutes REACHES tenantForUser/endTrialNow,
 * not what either of them does.
 */
export interface BillingDeps {
  tenantForUser: typeof tenantForUser;
  endTrialNow: typeof endTrialNow;
}

/** Wires the real singletons — the only place in this pilot that still does. */
export function createBillingDeps(): BillingDeps {
  return { tenantForUser, endTrialNow };
}
