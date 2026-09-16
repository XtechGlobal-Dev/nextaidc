import type { AuthUser } from "@/lib/api";

/** Walled behind the plan + card screen? Keyed on `cardConfirmedAt` (only /billing/confirm-card writes it), NOT
 *  `subscriptionStatus`, which goes "trialing"/"past_due"/"canceled" before any card exists. `cardRequiredAtSignup`
 *  is the account's own signup snapshot (non-retroactive); `=== true` so a pre-feature cached profile reads as grandfathered. */
export function cardWallActive(user: AuthUser | null | undefined): boolean {
  if (!user || user.role !== "USER") return false;
  const profile = user.profile;
  if (!profile || profile.cardRequiredAtSignup !== true) return false;
  return !profile.cardConfirmedAt;
}
