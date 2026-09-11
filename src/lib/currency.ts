/**
 * Pricing helper. Each plan carries its own `currency` (e.g. "usd", "aud") and
 * a price in that currency's minor units (cents); Stripe charges in the plan's
 * currency. Always format with the plan/subscription's own currency so legacy
 * USD subscribers and new AUD plans can coexist on the same screen.
 *
 * Note: a Stripe Price's currency is immutable — switching a plan's currency
 * means creating a new Stripe Price (the backend handles this on sync), and
 * plans with live subscribers are locked from pricing changes entirely.
 */

/** Fallback when a record predates the multi-currency support. */
export const DEFAULT_CURRENCY = "USD";

/**
 * Format a minor-units amount as a labelled price, e.g. "$49 AUD" or "$12.50 USD".
 * The ISO code is always appended so "$" is never ambiguous between USD/AUD/CAD.
 */
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

/**
 * How much a percentage coupon takes off a list price, in minor units.
 *
 * Shared rather than repeated at each call site because several screens quote
 * this number to the customer — the plan picker, the /subscribe rail, and the
 * go-live confirmation — and they have to agree. The last of those is the one
 * that actually takes the money, so a screen computing it differently (or not at
 * all) tells the customer they are about to be charged an amount that isn't what
 * leaves their card.
 *
 * Returns 0 for a bonus-minutes-only coupon: it discounts no money.
 */
export function couponDiscountCents(listCents: number, percentOff?: number | null): number {
  if (!percentOff || percentOff <= 0) return 0;
  return Math.round((listCents * percentOff) / 100);
}
