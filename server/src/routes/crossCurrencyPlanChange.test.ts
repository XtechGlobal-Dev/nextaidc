import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// Stripe fixes a subscription's currency at creation. Nothing checked, so $20 AUD → $20 USD compared equal as bare
// integers and ran to Stripe, failing at the swap AFTER the charge step. Source-inspection test (see bonusMinutesCycle.test.ts).

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
    // computeProration takes bare integers, so $20 USD and $20 AUD read as the same price.
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
    // A same-price switch charges nothing, so this path is reached with charged === 0 too —
    // promising a refund there sends support hunting for a payment that never existed.
    expect(changePlan).toMatch(/charged > 0\s*\n?\s*\?\s*"We took the upgrade payment/);
    expect(changePlan).toMatch(/nothing was charged/);
  });

  it("still charges before swapping, so a decline changes nothing", () => {
    // Swap-first would leave a customer on a plan they hadn't paid for. Scoped to the paid
    // branch because the trial path swaps with no charge and would otherwise be measured.
    const paidBranch = changePlan.slice(changePlan.indexOf("COLLECT FIRST"));
    expect(paidBranch.indexOf("chargeOneTime")).toBeGreaterThan(-1);
    expect(paidBranch.indexOf("chargeOneTime")).toBeLessThan(
      paidBranch.indexOf("swapSubscriptionPriceNow"),
    );
  });
});
