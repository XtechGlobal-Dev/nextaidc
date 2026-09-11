import type { SubscriptionPlan } from "@/lib/api";

/* ------------------------------------------------------------------ *
 *  Plan identity for analytics + the DOM.
 *
 *  Plan rows are created by admins, so the database id is a random cuid that
 *  differs between environments and means nothing in a GA4 report. The stable,
 *  human-readable identity is the plan's short key (`name`, e.g. "starter"),
 *  which is what we slugify here and use for:
 *    • the plan card's DOM id / data-attributes (GTM click triggers, CSS
 *      selectors, e2e tests), and
 *    • the `plan_slug` dimension on the dataLayer events.
 *
 *  Slugs are only as unique as the underlying plan keys. Admins can rename a
 *  plan, so anything that must be exact (reconciling against Stripe, support
 *  lookups) uses `plan_id` — pushed alongside the slug on every event.
 * ------------------------------------------------------------------ */

/** Only the fields the helpers need — works with any plan-shaped object. */
export type PlanIdentity = Pick<
  SubscriptionPlan,
  "id" | "name" | "displayName" | "priceCents" | "currency" | "interval"
>;

/**
 * Lowercase, dash-separated key for a plan — "Standard Plan" → "standard-plan".
 *
 * Prefers the admin short key (`name`) and falls back to the customer-facing
 * `displayName`, so a plan that was only ever given a display name still gets a
 * readable slug instead of an opaque id. A name with nothing slug-worthy in it
 * (empty, or all punctuation/non-Latin) falls back to the plan id, because an
 * ambiguous slug shared by two plans is worse in a report than an ugly one.
 */
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

/**
 * The plan dimensions pushed with every plan-related dataLayer event, so a GA4
 * report can group by `plan_slug` (readable) while `plan_id` stays exact.
 *
 * `plan_price` is in major currency units (49.00, not 4900) — GA4 and Google Ads
 * expect a currency amount there, not cents.
 */
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
