// Pricing helpers. Always format with the plan/subscription's own currency so legacy USD subscribers and
// new AUD plans coexist on one screen. A Stripe Price's currency is immutable; switching means a new Price.

/** Fallback when a record predates the multi-currency support. */
export const DEFAULT_CURRENCY = "USD";

/** Minor units -> "$49 AUD" / "$12.50 USD". The ISO code is always appended so "$" is never ambiguous. */
export function formatMoney(cents: number, currency?: string | null): string {
  const code = (currency || DEFAULT_CURRENCY).toUpperCase();
  const amount = new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: code,
    // "$49" instead of "A$49" — the appended code already disambiguates.
    currencyDisplay: "narrowSymbol",
    minimumFractionDigits: 0,
    // Whole prices show no cents; fractional ones show 2 decimals.
    maximumFractionDigits: 2,
  }).format(cents / 100);
  return `${amount} ${code}`;
}

/** Percentage-coupon discount in minor units. Shared so every screen quoting it agrees with the one that
 *  actually charges the card. 0 for a bonus-minutes-only coupon. */
export function couponDiscountCents(listCents: number, percentOff?: number | null): number {
  if (!percentOff || percentOff <= 0) return 0;
  return Math.round((listCents * percentOff) / 100);
}
