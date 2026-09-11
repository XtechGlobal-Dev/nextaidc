import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/* ------------------------------------------------------------------ *
 *  A subscription cannot change currency.
 *
 *  Stripe fixes a subscription's currency when it is created, so swapping in a
 *  price denominated in another one is rejected. Nothing checked for it, so a
 *  customer on a $20 AUD plan could click through to a $20 USD plan: the two
 *  prices compared equal as bare integers, the change was classified "same",
 *  and it ran all the way to Stripe — failing at the price swap, which sits
 *  AFTER the charge step.
 *
 *  Reported from staging as "We took the upgrade payment but couldn't switch
 *  your plan", on a change that had in fact charged nothing.
 *
 *  Source-inspection test in the house style (see bonusMinutesCycle.test.ts):
 *  the route is a long Express handler wired to Stripe, and what matters is
 *  where the guard sits relative to the money.
 * ------------------------------------------------------------------------- */

const src = readFileSync(resolve(import.meta.dirname, "billing.routes.ts"), "utf8");

/** The shared loader both the preview and the apply path run first. */
const contextLoader = (() => {
  const start = src.indexOf("async function loadPlanChangeContext");
  expect(start, "loadPlanChangeContext not found").toBeGreaterThan(-1);
  const end = src.indexOf("const planChangeSchema", start);
  return src.slice(start, end === -1 ? undefined : end);
})();

/** The `/change-plan` handler body — where money moves. */
const changePlan = (() => {
  const start = src.indexOf('"/change-plan"');
  expect(start, "/change-plan not found").toBeGreaterThan(-1);
  const end = src.indexOf("router.", start + 10);
  return src.slice(start, end === -1 ? undefined : end);
})();

describe("a plan change across currencies is refused", () => {
  it("compares the two plans' currencies", () => {
    expect(contextLoader).toMatch(/target\.currency !== current\.currency/);
  });

  it("refuses in the SHARED loader, so the preview is blocked too", () => {
    // In the apply handler alone, the customer would still be shown a priced
    // preview for a change that can never succeed.
    expect(contextLoader).toMatch(/A subscription can't change currency/);
  });

  it("refuses BEFORE the prices are compared", () => {
    // computeProration takes bare integers. Reaching it with two currencies
    // reads $20 USD and $20 AUD as the same price — which is exactly what the
    // confirmation dialog told the customer.
    expect(contextLoader.indexOf("target.currency !== current.currency")).toBeLessThan(
      contextLoader.indexOf("computeProration"),
    );
  });

  it("refuses before anything is charged or swapped", () => {
    // The guard lives in the loader, which every /change-plan call runs before
    // reaching chargeOneTime or swapSubscriptionPriceNow.
    expect(changePlan).toMatch(/loadPlanChangeContext\(userId, planId\)/);
    expect(changePlan.indexOf("loadPlanChangeContext")).toBeLessThan(
      changePlan.indexOf("chargeOneTime"),
    );
  });
});

describe("the failure message matches what actually happened", () => {
  it("only claims a payment was taken when one was", () => {
    // A same-price switch charges nothing (amountDueCents is 0 unless the
    // direction is "upgrade"), so this path is reached with charged === 0 too.
    // Promising a refund there sends the customer and support hunting for a
    // payment that never existed.
    expect(changePlan).toMatch(/charged > 0\s*\n?\s*\?\s*"We took the upgrade payment/);
    expect(changePlan).toMatch(/nothing was charged/);
  });

  it("still charges before swapping, so a decline changes nothing", () => {
    // Pre-existing ordering worth pinning while editing around it: the swap
    // running first would leave a customer on a plan they hadn't paid for.
    //
    // Scoped to the paid branch on purpose — the trial path swaps the price with
    // no charge at all, and that earlier call would otherwise be the one measured.
    const paidBranch = changePlan.slice(changePlan.indexOf("COLLECT FIRST"));
    expect(paidBranch.indexOf("chargeOneTime")).toBeGreaterThan(-1);
    expect(paidBranch.indexOf("chargeOneTime")).toBeLessThan(
      paidBranch.indexOf("swapSubscriptionPriceNow"),
    );
  });
});
