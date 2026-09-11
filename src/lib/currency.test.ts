import { describe, it, expect } from "vitest";
import { couponDiscountCents, formatMoney } from "./currency";

/* This number is quoted to the customer on three separate screens — the plan
 * picker, the /subscribe rail, and the go-live confirmation — and the last of
 * those is the one that actually takes the money. They were computing it
 * independently, which is how the confirmation dialog came to promise a charge
 * of $20 while the invoice said $13. One function now, pinned here. */

describe("couponDiscountCents", () => {
  it("takes the percentage off the list price", () => {
    // The reported case: a $20 plan with 35% off is charged $13.
    expect(couponDiscountCents(2000, 35)).toBe(700);
    expect(2000 - couponDiscountCents(2000, 35)).toBe(1300);
  });

  it("discounts nothing without a percentage coupon", () => {
    // A bonus-minutes-only coupon takes no money off, and neither does no coupon.
    expect(couponDiscountCents(2000, null)).toBe(0);
    expect(couponDiscountCents(2000, undefined)).toBe(0);
    expect(couponDiscountCents(2000, 0)).toBe(0);
  });

  it("takes the whole price on a 100% coupon", () => {
    expect(2000 - couponDiscountCents(2000, 100)).toBe(0);
  });

  it("rounds to whole cents rather than leaving a fraction", () => {
    // 33% of $19.99 is 659.67 cents — Stripe bills integers, so must we.
    const discount = couponDiscountCents(1999, 33);
    expect(Number.isInteger(discount)).toBe(true);
    expect(discount).toBe(660);
  });

  it("ignores a negative percentage instead of inflating the price", () => {
    expect(couponDiscountCents(2000, -10)).toBe(0);
  });

  it("leaves a zero price alone", () => {
    expect(couponDiscountCents(0, 50)).toBe(0);
  });
});

describe("formatMoney", () => {
  it("appends the currency code so $ is never ambiguous", () => {
    expect(formatMoney(1300, "aud")).toBe("$13 AUD");
    expect(formatMoney(1300, "usd")).toBe("$13 USD");
  });

  it("shows cents only when the amount has them", () => {
    expect(formatMoney(2000, "aud")).toBe("$20 AUD");
    // Trailing zeros are dropped (minimumFractionDigits: 0), so $12.50 renders
    // as "$12.5". Recorded rather than asserted as ideal — plan prices are whole
    // numbers today, and changing it would move every price on every screen.
    expect(formatMoney(1250, "aud")).toBe("$12.5 AUD");
  });
});
