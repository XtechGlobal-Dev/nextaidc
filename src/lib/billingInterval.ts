/**
 * Billing-cycle labels — how long one paid period lasts.
 *
 * A cycle is `interval` x `intervalCount` (Stripe's model), so "every 3 months"
 * is interval="month" with intervalCount=3. Mirrors
 * `server/src/lib/billingInterval.ts`; keep the two in step.
 */

/** Cycle lengths an admin may choose, in months. */
export const MONTHLY_INTERVAL_COUNTS = [1, 2, 3, 6, 12] as const;

/**
 * The cycle as it appears after a price — "$49/month", "$129/3 months".
 *
 * A 12-month cycle reads as "year" because that is what a customer calls it;
 * the stored value stays month x 12 so the Stripe price and the minute
 * allowance need no special case.
 */
export function intervalLabel(interval?: string | null, intervalCount?: number | null): string {
  const unit = interval || "month";
  const count = typeof intervalCount === "number" && intervalCount > 0 ? Math.floor(intervalCount) : 1;
  if (unit === "month" && count === 12) return "year";
  if (count === 1) return unit;
  return `${count} ${unit}s`;
}

/** Dropdown label for the plan form — "Monthly", "Every 3 months", "Yearly". */
export function intervalOptionLabel(count: number): string {
  if (count === 1) return "Monthly";
  if (count === 12) return "Yearly (12 months)";
  return `Every ${count} months`;
}
