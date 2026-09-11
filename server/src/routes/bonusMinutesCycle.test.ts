import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/* ------------------------------------------------------------------ *
 *  Bonus minutes are granted per BILLING CYCLE.
 *
 *  A coupon's bonus (e.g. +200 minutes) belongs to a cycle, and every path that
 *  opens one — checkout, trial conversion, date renewal, early renewal, manual
 *  renew — grants it through `effectiveIncludedMinutes`.
 *
 *  A mid-cycle upgrade is NOT such a path: the delta is a standalone invoice,
 *  not a subscription cycle (which is also why nothing calls consumeCycle
 *  there). It used to grant the bonus again anyway, on top of a reset
 *  allowance — so a customer could upgrade, spend 200 bonus minutes, upgrade
 *  again, and collect another 200, inside a single cycle.
 *
 *  This is a source-inspection test in the house style: the route is a long
 *  Express handler wired to Stripe, and what matters is which allowance is
 *  passed at each call site.
 * ------------------------------------------------------------------------- */

const src = readFileSync(resolve(import.meta.dirname, "billing.routes.ts"), "utf8");
const trialSrc = readFileSync(resolve(import.meta.dirname, "../services/trial.ts"), "utf8");

/** The `/change-plan` handler body — where an upgrade grants its allowance. */
const changePlan = (() => {
  const start = src.indexOf('"/change-plan"');
  expect(start).toBeGreaterThan(-1);
  const end = src.indexOf("router.", start + 10);
  return src.slice(start, end === -1 ? undefined : end);
})();

describe("a mid-cycle upgrade does not re-grant the coupon's bonus minutes", () => {
  it("passes the plan's own minutes, not the coupon-inflated allowance", () => {
    expect(changePlan).toMatch(/includedMinutes: target\.includedMinutes,/);
  });

  it("never calls effectiveIncludedMinutes on the upgrade path", () => {
    // The one call that made repeat-upgrading a way to farm bonus minutes.
    expect(changePlan).not.toMatch(/effectiveIncludedMinutes/);
  });

  it("still resets usage — the customer paid the new plan's full price", () => {
    expect(changePlan).toMatch(/resetUsage: proration\.direction === "upgrade"/);
  });
});

describe("every real cycle boundary still grants the bonus", () => {
  /** Each of these opens a new billing cycle, so the bonus belongs to it. */
  it("the checkout charge does", () => {
    expect(src).toMatch(/activateRedemption\(userId, profile\.stripeSubscriptionId\);[\s\S]{0,400}?effectiveIncludedMinutes/);
  });

  it("Stripe's date renewal and our manual renew do", () => {
    // Two call sites beyond the checkout one, both in this file.
    const hits = src.match(/effectiveIncludedMinutes\(/g) ?? [];
    expect(hits.length).toBeGreaterThanOrEqual(3);
  });

  it("the early (minutes-exhausted) renewal and trial conversion do", () => {
    const hits = trialSrc.match(/effectiveIncludedMinutes\(/g) ?? [];
    // Three call sites plus the export itself.
    expect(hits.length).toBeGreaterThanOrEqual(3);
  });
});
