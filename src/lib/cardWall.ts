import type { AuthUser } from "@/lib/api";

/**
 * Is this account walled behind the plan + card screen?
 *
 * True only for a CUSTOMER that signed up while the platform required a card and
 * has never confirmed one. `/billing/confirm-card` is the sole writer of
 * `cardConfirmedAt`, so it is the one trustworthy "a card actually landed" signal.
 *
 * Deliberately NOT keyed on `subscriptionStatus`. That string is written from
 * several places outside this flow: `/subscribe` opens a real Stripe trial
 * subscription before any card exists, so Stripe reports "trialing" and the
 * billing webhook mirrors it; `/billing/renew`'s failure path writes "past_due";
 * an abandoned trial is cancelled to "canceled". Any of those would silently drop
 * the wall for a user who never entered a card.
 *
 * `cardRequiredAtSignup` is the account's OWN signup snapshot, never the live
 * admin toggle — which is what makes the policy non-retroactive: an account
 * created under the card-less rule is never walled, whatever the toggle says
 * today. Both fields are absent on a profile cached in localStorage before this
 * shipped, hence the `=== true` test: undefined must mean "grandfathered", never
 * "wall them", or every existing user would be locked out until /me refreshes.
 */
export function cardWallActive(user: AuthUser | null | undefined): boolean {
  if (!user || user.role !== "USER") return false;
  const profile = user.profile;
  if (!profile || profile.cardRequiredAtSignup !== true) return false;
  return !profile.cardConfirmedAt;
}
