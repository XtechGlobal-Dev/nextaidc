// Billing-cycle rules. Plans use Stripe's shape: interval + intervalCount ("every 3 months" = month/3). No I/O.

/** Cycle lengths an admin may choose, in months. */
export const MONTHLY_INTERVAL_COUNTS = [1, 2, 3, 6, 12] as const;

/** Stripe refuses cycles over one year; enforce here rather than after the plan row is written. */
export const MAX_MONTHLY_INTERVAL_COUNT = 12;

/** Months in one cycle, for any supported interval unit. */
const MONTHS_PER_UNIT: Record<string, number> = { month: 1, year: 12, week: 1 / 4.345 };

/** Months per cycle (the MRR divisor). Weeks are approximate on purpose — 4.345/month is close enough for reporting. */
export function cycleMonths(interval: string, intervalCount = 1): number {
  const unit = MONTHS_PER_UNIT[interval] ?? 1;
  const count = Number.isFinite(intervalCount) && intervalCount > 0 ? intervalCount : 1;
  return unit * count;
}

/** Cycle label: "month", "3 months", "year". month/12 reads as "year" but stays stored as month/12. */
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
