/**
 * Billing-cycle vocabulary — how long one paid period lasts.
 *
 * Stripe models a cycle as `recurring: { interval, interval_count }`, so
 * "every 3 months" is interval="month" with interval_count=3. Plans carry the
 * same pair (`interval` + `intervalCount`).
 *
 * No I/O here, so the same rules can be asserted in tests and reused by the
 * plan input schema, the Stripe price builders and the MRR normaliser without
 * any of them re-deriving them.
 */

/** Cycle lengths an admin may choose, in months. */
export const MONTHLY_INTERVAL_COUNTS = [1, 2, 3, 6, 12] as const;

/**
 * Stripe refuses a recurring price whose cycle exceeds one year, so with
 * interval="month" the count cannot go past 12. Enforced here rather than
 * discovered as a Stripe API error after the plan row is already written.
 */
export const MAX_MONTHLY_INTERVAL_COUNT = 12;

/** Months in one cycle, for any supported interval unit. */
const MONTHS_PER_UNIT: Record<string, number> = { month: 1, year: 12, week: 1 / 4.345 };

/**
 * How many months one billing cycle spans — the divisor that turns a plan's
 * price into monthly recurring revenue.
 *
 * Weeks are deliberately approximate (4.345 weeks/month, the same average the
 * old monthlyCents used): a weekly plan has no exact month, and revenue
 * reporting only needs it to be close.
 */
export function cycleMonths(interval: string, intervalCount = 1): number {
  const unit = MONTHS_PER_UNIT[interval] ?? 1;
  const count = Number.isFinite(intervalCount) && intervalCount > 0 ? intervalCount : 1;
  return unit * count;
}

/**
 * Customer-facing cycle label: "month", "3 months", "year".
 *
 * A 12-month cycle reads as "year" because that is what a customer calls it —
 * the stored value stays interval="month"/count=12 so the Stripe price and the
 * minute allowance need no special case.
 */
export function intervalLabel(interval: string, intervalCount = 1): string {
  const count = Number.isFinite(intervalCount) && intervalCount > 0 ? Math.floor(intervalCount) : 1;
  if (interval === "month" && count === 12) return "year";
  if (count === 1) return interval;
  return `${count} ${interval}s`;
}

/** True when the pair is one this product is willing to create. */
export function isSupportedInterval(interval: string, intervalCount = 1): boolean {
  if (interval !== "month") return interval === "week" || interval === "year" ? intervalCount === 1 : false;
  return (MONTHLY_INTERVAL_COUNTS as readonly number[]).includes(intervalCount);
}
