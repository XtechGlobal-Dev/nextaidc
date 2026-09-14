import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// Source-inspection tests for the coupon PATCH handler, pinning past bugs: code edits never saved,
// percentage changes kept the old (immutable) Stripe coupon, renames onto a taken code threw raw.

const src = readFileSync(resolve(import.meta.dirname, "admin.routes.ts"), "utf8");

/** The body of the PATCH /coupons/:id handler. Split on route registrations
 *  rather than matching exact whitespace, so CRLF/formatting can't break it. */
const patchCoupon = (() => {
  const chunk = src
    .split(/router\.(?:get|post|patch|put|delete)\(/)
    .find((c) => /^\s*"\/coupons\/:id"/.test(c) && /requirePermission\("coupons", "edit"\)/.test(c));
  expect(chunk, "PATCH /coupons/:id route not found").toBeDefined();
  return chunk!;
})();

describe("PATCH /api/admin/coupons/:id", () => {
  it("writes the code to the database — the field the original bug dropped", () => {
    // The whole bug was a `data: { ... }` object with no `code` key. Anything
    // that only *reads* data.code (the guard) is not enough.
    expect(patchCoupon).toMatch(/data:\s*\{[\s\S]*\bcode:\s*nextCode\b/);
  });

  it("resolves the post-patch code from the request, falling back to the stored one", () => {
    expect(patchCoupon).toMatch(
      /const nextCode\s*=\s*data\.code !== undefined \? normalizeCode\(data\.code\) : exists\.code/,
    );
  });

  it("rejects renaming onto a code that already exists", () => {
    expect(patchCoupon).toMatch(/nextCode !== exists\.code/);
    expect(patchCoupon).toMatch(/already in use/i);
  });

  it("keeps coupon codes out of the reseller referral-code namespace on rename", () => {
    expect(patchCoupon).toMatch(/referralCode: nextCode/);
    expect(patchCoupon).toMatch(/already a reseller referral code/i);
  });

  it("replaces the Stripe coupon when the discount or duration changes", () => {
    // Stripe coupons can't be edited, so a changed rate MUST mint a new object.
    expect(patchCoupon).toMatch(/const termsChanged\s*=/);
    expect(patchCoupon).toMatch(/deleteStripeCoupon\(exists\.stripeCouponId\)/);
    expect(patchCoupon).toMatch(/syncStripeCoupon\(\{/);
    // ...and the new id has to actually be persisted.
    expect(patchCoupon).toMatch(/data:\s*\{[\s\S]*\bstripeCouponId,/);
  });

  it("still refuses to change terms once the coupon is locked", () => {
    expect(patchCoupon).toMatch(/const \{ redeemed, locked \} = await couponUsage/);
    expect(patchCoupon).toMatch(/if \(locked\)/);
    // The terms fields collapse to the stored value unless the coupon is free.
    expect(patchCoupon).toMatch(/!locked && data\.percentOff !== undefined/);
    expect(patchCoupon).toMatch(/!locked && data\.durationCycles !== undefined/);
  });

  it("locks on a checkout in progress, not only on completed redemptions", () => {
    // A customer on the card step has already been shown these terms, so moving
    // them underneath is the same wrong as rewriting a finished redemption.
    const usage = src.slice(src.indexOf("async function couponUsage"));
    expect(usage).toMatch(/status: "pending"/);
    expect(usage).toMatch(/reservedAt: \{ gt: cutoff \}/);
    expect(usage).toMatch(/locked: redeemed \+ livePending > 0/);
    // ...but a STALE reservation must not freeze admin edits forever.
    expect(usage).toMatch(/PENDING_RESERVATION_TTL_MS/);
  });

  it("won't let an edit strip a coupon of all its value", () => {
    expect(patchCoupon).toMatch(/nextPercentOff == null && nextBonusMinutes == null/);
  });

  // Bug: an expired coupon couldn't be edited at all, because the date guard treated "present in payload"
  // as "changed" — and the admin form submits every field on every save.
  it("guards dates against the STORED value, not merely their presence", () => {
    // The bug was `data.expiresAt !== undefined && ...`.
    expect(patchCoupon).not.toMatch(/data\.expiresAt !== undefined &&\s*mergedExpiresAt/);
    expect(patchCoupon).not.toMatch(/data\.startsAt !== undefined &&\s*mergedStartsAt/);
    // Both guards must compare the merged value with what's on file.
    expect(patchCoupon).toMatch(/sameInstant\(mergedExpiresAt, exists\.expiresAt\)/);
    expect(patchCoupon).toMatch(/sameInstant\(mergedStartsAt, exists\.startsAt\)/);
  });

  it("still rejects a date actually moved into the past", () => {
    expect(patchCoupon).toMatch(/mergedExpiresAt <= new Date\(\)/);
    expect(patchCoupon).toMatch(/mergedStartsAt < earliestAllowedStart\(\)/);
  });
});
