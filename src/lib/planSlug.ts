import type { SubscriptionPlan } from "@/lib/api";

// Plan identity for analytics + DOM ids. Plan ids are per-environment cuids that mean nothing in GA4, so we
// slugify the short key; admins can rename plans, so anything that must be exact uses `plan_id` alongside.

/** Only the fields the helpers need — works with any plan-shaped object. */
export type PlanIdentity = Pick<
  SubscriptionPlan,
  "id" | "name" | "displayName" | "priceCents" | "currency" | "interval"
>;

/** "Standard Plan" -> "standard-plan". Prefers `name`, then `displayName`; a name with nothing slug-worthy
 *  falls back to the plan id, since an ambiguous shared slug is worse in a report than an ugly one. */
export function planSlug(plan: Pick<PlanIdentity, "id" | "name" | "displayName">): string {
  const source = (plan.name || plan.displayName || "").trim();
  const slug = source
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-") // punctuation, spaces, anything non-Latin → dash
    .replace(/^-+|-+$/g, ""); // no leading/trailing dashes
  return slug || `plan-${plan.id}`;
}

/** DOM id for a plan card — `plan-card-starter`. Stable across environments, so
 *  GTM click triggers and e2e selectors can target a specific plan. */
export function planCardId(plan: Pick<PlanIdentity, "id" | "name" | "displayName">): string {
  return `plan-card-${planSlug(plan)}`;
}

/** Plan dimensions for every plan-related dataLayer event. `plan_price` is in major units (49.00, not 4900): GA4/Ads expect a currency amount. */
export function planAnalyticsParams(plan: PlanIdentity): Record<string, unknown> {
  return {
    plan_slug: planSlug(plan),
    plan_id: plan.id,
    plan_name: plan.displayName || plan.name,
    plan_price: plan.priceCents / 100,
    currency: (plan.currency || "USD").toUpperCase(),
    plan_interval: plan.interval,
  };
}
