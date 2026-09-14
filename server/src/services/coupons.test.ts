import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../prisma.js", () => ({
  prisma: {
    coupon: { findUnique: vi.fn(), findFirst: vi.fn(), findMany: vi.fn(), update: vi.fn() },
    couponRedemption: {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      findMany: vi.fn(async () => []),
      count: vi.fn(async () => 0),
      create: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(async () => ({ count: 0 })),
      delete: vi.fn(),
      deleteMany: vi.fn(async () => ({ count: 0 })),
    },
    planEvent: { findFirst: vi.fn(async () => null) },
    // `update` resolves: production code chains .catch() on it for best-effort
    // writes, which a bare vi.fn() (returning undefined) would blow up on.
    profile: { findUnique: vi.fn(async () => null), update: vi.fn(async () => ({})) },
    $transaction: vi.fn(),
    // The coupon write paths take a FOR UPDATE row lock on the profile before
    // deciding the live discount, so the mocked client has to answer it.
    $executeRaw: vi.fn(async () => 1),
  },
}));

vi.mock("./stripe.js", () => ({
  isStripeConfigured: vi.fn(() => true),
  createStripeCoupon: vi.fn(async () => "co_new"),
  deleteStripeCoupon: vi.fn(async () => {}),
  attachSubscriptionDiscount: vi.fn(async () => {}),
  detachSubscriptionDiscount: vi.fn(async () => {}),
  getSubscriptionDiscountCouponId: vi.fn(async () => null),
  setSchedulePhaseDiscounts: vi.fn(async () => {}),
}));

vi.mock("./planHistory.js", () => ({ recordPlanEvent: vi.fn(async () => {}) }));

import { prisma } from "../prisma.js";
/** The stand-in above, typed as what it is: mocks by model and method. */
const fake = prisma as unknown as Record<string, Record<string, ReturnType<typeof vi.fn>>>;
import {
  attachSubscriptionDiscount,
  detachSubscriptionDiscount,
  getSubscriptionDiscountCouponId,
  isStripeConfigured,
  setSchedulePhaseDiscounts,
} from "./stripe.js";
import {
  PENDING_RESERVATION_TTL_MS,
  activateRedemption,
  consumeCycle,
  effectiveIncludedMinutes,
  getActiveRedemption,
  grantCoupon,
  grantableCoupons,
  healDiscountDrift,
  normalizeCode,
  reserveRedemption,
  syncStripeCoupon,
  validateCoupon,
} from "./coupons.js";

const couponFindUnique = prisma.coupon.findUnique as unknown as ReturnType<typeof vi.fn>;
const couponFindFirst = prisma.coupon.findFirst as unknown as ReturnType<typeof vi.fn>;
const redemptionFindUnique = fake.couponRedemption.findUnique as unknown as ReturnType<typeof vi.fn>;
const redemptionFindFirst = fake.couponRedemption.findFirst as unknown as ReturnType<typeof vi.fn>;
const redemptionCount = fake.couponRedemption.count as unknown as ReturnType<typeof vi.fn>;
const redemptionUpdate = fake.couponRedemption.update as unknown as ReturnType<typeof vi.fn>;
// Billing history lives in the customer brand database; the stand-in hands back
// the same stubbed plan-history model the suite already drives.
vi.mock("./tenantDb.js", async () => {
  const { prisma } = await import("../prisma.js");
  class TenantUnavailableError extends Error {}
  // The customer's brand's database is the same stand-in as Main here.
  return { tenantForUser: async () => prisma, allTenants: async () => [{ brandId: "b1", db: prisma }], TenantUnavailableError };
});

const planEventFindFirst = fake.planEvent.findFirst as unknown as ReturnType<typeof vi.fn>;
const profileFindUnique = fake.profile.findUnique as unknown as ReturnType<typeof vi.fn>;
const transaction = prisma.$transaction as unknown as ReturnType<typeof vi.fn>;
const attachDiscount = attachSubscriptionDiscount as unknown as ReturnType<typeof vi.fn>;
const detachDiscount = detachSubscriptionDiscount as unknown as ReturnType<typeof vi.fn>;
const getAttached = getSubscriptionDiscountCouponId as unknown as ReturnType<typeof vi.fn>;
const stripeConfigured = isStripeConfigured as unknown as ReturnType<typeof vi.fn>;

/** A live, unrestricted 30%-off coupon good for 3 billing cycles. */
const coupon = (over: Record<string, unknown> = {}) => ({
  id: "c1",
  code: "LAUNCH30",
  displayName: "Launch offer",
  description: "",
  percentOff: 30,
  bonusMinutes: null,
  durationCycles: 3,
  startsAt: null,
  expiresAt: null,
  maxRedemptions: null,
  redeemedCount: 0,
  newCustomersOnly: false,
  planIds: [] as string[],
  active: true,
  stripeCouponId: "co_stripe",
  ...over,
});

const redemption = (over: Record<string, unknown> = {}) => ({
  id: "r1",
  couponId: "c1",
  userId: "u1",
  status: "active",
  cyclesUsed: 0,
  lastCountedPeriodEnd: null as Date | null,
  reservedAt: new Date(),
  appliedAt: new Date(),
  endedAt: null,
  grantedBy: null,
  coupon: coupon(),
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  stripeConfigured.mockReturnValue(true);
  redemptionCount.mockResolvedValue(0);
  planEventFindFirst.mockResolvedValue(null);
  profileFindUnique.mockResolvedValue({ stripeSubscriptionId: "sub_1" });
  // Default: run the callback form, and resolve the array form to nothing.
  transaction.mockImplementation(async (arg: unknown) =>
    typeof arg === "function" ? (arg as (tx: unknown) => unknown)(prisma) : [],
  );
});

describe("normalizeCode", () => {
  it("uppercases and trims, so entry is case-insensitive", () => {
    expect(normalizeCode("  launch30 ")).toBe("LAUNCH30");
  });
});

describe("validateCoupon — rejection paths", () => {
  const args = { code: "LAUNCH30", userId: "u1", planId: "p1" };

  it("rejects an unknown code", async () => {
    couponFindUnique.mockResolvedValue(null);
    expect(await validateCoupon(args)).toEqual({ ok: false, reason: "not_found" });
  });

  it("rejects a deactivated coupon", async () => {
    couponFindUnique.mockResolvedValue(coupon({ active: false }));
    expect(await validateCoupon(args)).toEqual({ ok: false, reason: "inactive" });
  });

  it("rejects before the redemption window opens", async () => {
    couponFindUnique.mockResolvedValue(coupon({ startsAt: new Date(Date.now() + 86_400_000) }));
    expect(await validateCoupon(args)).toEqual({ ok: false, reason: "not_started" });
  });

  it("rejects after the redemption window closes", async () => {
    couponFindUnique.mockResolvedValue(coupon({ expiresAt: new Date(Date.now() - 1000) }));
    expect(await validateCoupon(args)).toEqual({ ok: false, reason: "expired" });
  });

  it("rejects a plan the coupon doesn't cover", async () => {
    couponFindUnique.mockResolvedValue(coupon({ planIds: ["p-other"] }));
    redemptionFindUnique.mockResolvedValue(null);
    expect(await validateCoupon(args)).toEqual({ ok: false, reason: "plan_not_eligible" });
  });

  it("rejects a percentage coupon when Stripe isn't configured", async () => {
    stripeConfigured.mockReturnValue(false);
    couponFindUnique.mockResolvedValue(coupon());
    expect(await validateCoupon(args)).toEqual({ ok: false, reason: "stripe_unavailable" });
  });

  it("still allows a bonus-minutes-only coupon without Stripe — no money moves", async () => {
    stripeConfigured.mockReturnValue(false);
    couponFindUnique.mockResolvedValue(coupon({ percentOff: null, bonusMinutes: 200 }));
    redemptionFindUnique.mockResolvedValue(null);
    expect((await validateCoupon(args)).ok).toBe(true);
  });

  it("rejects a returning customer when newCustomersOnly, using PLAN HISTORY not current status", async () => {
    couponFindUnique.mockResolvedValue(coupon({ newCustomersOnly: true }));
    redemptionFindUnique.mockResolvedValue(null);
    // Cancelled long ago, so their status reads "none" today — but they HAVE paid.
    planEventFindFirst.mockResolvedValue({ id: "pe1" });
    expect(await validateCoupon(args)).toEqual({ ok: false, reason: "not_new_customer" });
  });
});

describe("validateCoupon — one redemption per user, forever", () => {
  const args = { code: "LAUNCH30", userId: "u1", planId: "p1" };

  it.each(["active", "exhausted", "revoked"])(
    "blocks re-entry when the user already has a %s redemption",
    async (status) => {
      couponFindUnique.mockResolvedValue(coupon());
      redemptionFindUnique.mockResolvedValue(redemption({ status }));
      expect(await validateCoupon(args)).toEqual({ ok: false, reason: "already_used" });
    },
  );

  // Backing out of checkout must never cost you your own coupon — a `pending` row is an unfinished attempt, not a redemption.
  it("does NOT block on the user's own FRESH reservation (they backed out of checkout)", async () => {
    couponFindUnique.mockResolvedValue(coupon());
    redemptionFindUnique.mockResolvedValue(redemption({ status: "pending", reservedAt: new Date() }));
    expect((await validateCoupon(args)).ok).toBe(true);
  });

  it("does NOT block a user whose reservation went stale — they never actually used it", async () => {
    couponFindUnique.mockResolvedValue(coupon());
    redemptionFindUnique.mockResolvedValue(
      redemption({
        status: "pending",
        reservedAt: new Date(Date.now() - PENDING_RESERVATION_TTL_MS - 1000),
      }),
    );
    expect((await validateCoupon(args)).ok).toBe(true);
  });

  it("doesn't report the last slot sold out to the very user holding it", async () => {
    // Cap of 1, and the one live reservation is this user's own retry.
    couponFindUnique.mockResolvedValue(coupon({ maxRedemptions: 1, redeemedCount: 0 }));
    redemptionFindUnique.mockResolvedValue(redemption({ status: "pending", reservedAt: new Date() }));
    redemptionCount.mockResolvedValue(1);
    expect((await validateCoupon(args)).ok).toBe(true);
  });

  it("still sells out to a DIFFERENT user when someone else holds the last slot", async () => {
    couponFindUnique.mockResolvedValue(coupon({ maxRedemptions: 1, redeemedCount: 0 }));
    redemptionFindUnique.mockResolvedValue(null); // this user holds nothing
    redemptionCount.mockResolvedValue(1); // somebody else's cart
    expect(await validateCoupon(args)).toEqual({ ok: false, reason: "sold_out" });
  });
});

describe("validateCoupon — supply cap counts live reservations", () => {
  const args = { code: "LAUNCH30", userId: "u1", planId: "p1" };

  it("sells out on redeemedCount alone", async () => {
    couponFindUnique.mockResolvedValue(coupon({ maxRedemptions: 5, redeemedCount: 5 }));
    redemptionFindUnique.mockResolvedValue(null);
    expect(await validateCoupon(args)).toEqual({ ok: false, reason: "sold_out" });
  });

  it("sells out when in-flight checkouts fill the remaining slots", async () => {
    couponFindUnique.mockResolvedValue(coupon({ maxRedemptions: 5, redeemedCount: 3 }));
    redemptionFindUnique.mockResolvedValue(null);
    redemptionCount.mockResolvedValue(2); // two carts holding the last two
    expect(await validateCoupon(args)).toEqual({ ok: false, reason: "sold_out" });
  });

  it("still sells while a slot is free", async () => {
    couponFindUnique.mockResolvedValue(coupon({ maxRedemptions: 5, redeemedCount: 3 }));
    redemptionFindUnique.mockResolvedValue(null);
    redemptionCount.mockResolvedValue(1);
    expect((await validateCoupon(args)).ok).toBe(true);
  });
});

describe("reserveRedemption", () => {
  it("clears the user's own stale reservation so a retry isn't blocked by the unique index", async () => {
    couponFindUnique.mockResolvedValue(coupon());
    redemptionFindUnique.mockResolvedValue(null);
    (fake.couponRedemption.create as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(
      redemption({ status: "pending" }),
    );

    await reserveRedemption("c1", "u1");

    const deleteMany = fake.couponRedemption.deleteMany as unknown as ReturnType<typeof vi.fn>;
    expect(deleteMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ couponId: "c1", userId: "u1", status: "pending" }),
      }),
    );
  });

  it("reuses a fresh reservation instead of failing a double-submit", async () => {
    const held = redemption({ status: "pending" });
    redemptionFindUnique.mockResolvedValue(held);
    const result = await reserveRedemption("c1", "u1");
    expect(result).toBe(held);
    expect(fake.couponRedemption.create).not.toHaveBeenCalled();
  });

  it("refuses to oversell the last slot", async () => {
    redemptionFindUnique.mockResolvedValue(null);
    couponFindUnique.mockResolvedValue(coupon({ maxRedemptions: 2, redeemedCount: 1 }));
    redemptionCount.mockResolvedValue(1); // one cart already holds the last slot
    await expect(reserveRedemption("c1", "u1")).rejects.toThrow(/sold out/i);
  });
});

describe("consumeCycle", () => {
  it("counts a cycle and leaves the discount running while budget remains", async () => {
    redemptionFindFirst.mockResolvedValue(redemption({ cyclesUsed: 0 }));
    await consumeCycle("u1", "sub_1", new Date("2026-09-01"));
    expect(redemptionUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ cyclesUsed: 1 }) }),
    );
    expect(detachDiscount).not.toHaveBeenCalled();
  });

  // Bug: a 2-cycle coupon discounted the 3rd charge. Early renewals (billing_cycle_anchor: "now") put two
  // period ends minutes apart, so the one-hour "same period" dedupe dropped the second and the budget never ran out.
  it("counts a second charge made the same day, minutes after the first", async () => {
    const firstCycleEnd = new Date("2026-09-11T10:00:00.000Z");
    const secondCycleEnd = new Date("2026-09-11T10:12:00.000Z"); // renewed 12 min later
    redemptionFindFirst.mockResolvedValue(
      redemption({ cyclesUsed: 1, lastCountedPeriodEnd: firstCycleEnd }),
    );

    await consumeCycle("u1", "sub_1", secondCycleEnd, "in_second");

    expect(
      redemptionUpdate,
      "the second charge is a real cycle, not a duplicate event",
    ).toHaveBeenCalled();
  });

  it("retires a 2-cycle coupon on its second same-day charge, so the 3rd is full price", async () => {
    redemptionFindFirst.mockResolvedValue(
      redemption({
        cyclesUsed: 1,
        lastCountedPeriodEnd: new Date("2026-09-11T10:00:00.000Z"),
        coupon: coupon({ durationCycles: 2 }),
      }),
    );

    await consumeCycle("u1", "sub_1", new Date("2026-09-11T10:12:00.000Z"), "in_second");

    expect(detachDiscount, "budget spent → the discount must come off").toHaveBeenCalledWith(
      "sub_1",
    );
  });

  it("still ignores a repeat event for a charge already counted", async () => {
    // The dedupe's real job: subscription.updated fires for edits that move no money and carry an already-counted invoice.
    redemptionFindFirst.mockResolvedValue(
      redemption({ cyclesUsed: 1, lastCountedInvoiceId: "in_first" }),
    );

    await consumeCycle("u1", "sub_1", new Date("2026-09-11T10:12:00.000Z"), "in_first");

    expect(redemptionUpdate).not.toHaveBeenCalled();
  });

  it("retires the discount and detaches it once the budget is spent", async () => {
    redemptionFindFirst.mockResolvedValue(redemption({ cyclesUsed: 2 })); // 3rd of 3
    await consumeCycle("u1", "sub_1", new Date("2026-09-01"));
    expect(detachDiscount).toHaveBeenCalledWith("sub_1");
  });

  it("keeps the spent row (as exhausted) — it is what blocks re-entry", async () => {
    redemptionFindFirst.mockResolvedValue(redemption({ cyclesUsed: 2 }));
    await consumeCycle("u1", "sub_1", new Date("2026-09-01"));
    expect(redemptionUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: "exhausted", cyclesUsed: 3 }),
      }),
    );
    // Deleting it would hand the user a second run at the same code.
    expect(fake.couponRedemption.delete).not.toHaveBeenCalled();
  });

  // Writing schedule phases can silently drop a Stripe discount, so the cycle boundary re-checks it.
  // Here and not on reconcile — that runs on every gated request, too often for a Stripe call.
  describe("re-attaches a discount that went missing", () => {
    it("puts it back when Stripe shows none and cycles remain", async () => {
      redemptionFindFirst.mockResolvedValue(redemption({ cyclesUsed: 0 }));
      getAttached.mockResolvedValue(null);

      await consumeCycle("u1", "sub_1", new Date("2026-09-01"));

      expect(attachDiscount).toHaveBeenCalledWith("sub_1", "co_stripe");
    });

    it("leaves an already-attached discount alone", async () => {
      redemptionFindFirst.mockResolvedValue(redemption({ cyclesUsed: 0 }));
      getAttached.mockResolvedValue("co_stripe");

      await consumeCycle("u1", "sub_1", new Date("2026-09-01"));

      expect(attachDiscount).not.toHaveBeenCalled();
    });

    it("never re-attaches a `once` coupon — Stripe removed it on purpose", async () => {
      // durationCycles 1 → this cycle is its last anyway; putting it back would
      // hand out a discount that was already spent.
      redemptionFindFirst.mockResolvedValue(
        redemption({ cyclesUsed: 0, coupon: coupon({ durationCycles: 1 }) }),
      );
      getAttached.mockResolvedValue(null);

      await consumeCycle("u1", "sub_1", new Date("2026-09-01"));

      expect(attachDiscount).not.toHaveBeenCalled();
    });

    it("does nothing on the cycle that retires the coupon", async () => {
      redemptionFindFirst.mockResolvedValue(redemption({ cyclesUsed: 2 })); // 3rd of 3
      getAttached.mockResolvedValue(null);

      await consumeCycle("u1", "sub_1", new Date("2026-09-01"));

      expect(attachDiscount).not.toHaveBeenCalled();
      expect(detachDiscount).toHaveBeenCalledWith("sub_1");
    });

    it("skips a coupon that was never synced to Stripe", async () => {
      redemptionFindFirst.mockResolvedValue(
        redemption({ cyclesUsed: 0, coupon: coupon({ stripeCouponId: null }) }),
      );
      getAttached.mockResolvedValue(null);

      await consumeCycle("u1", "sub_1", new Date("2026-09-01"));

      expect(attachDiscount).not.toHaveBeenCalled();
    });

    it("survives Stripe being unreachable — a renewal must not break over this", async () => {
      redemptionFindFirst.mockResolvedValue(redemption({ cyclesUsed: 0 }));
      getAttached.mockRejectedValue(new Error("stripe down"));

      await expect(consumeCycle("u1", "sub_1", new Date("2026-09-01"))).resolves.toBeUndefined();
      // The cycle itself was still counted — that's the part that must not be lost.
      expect(redemptionUpdate).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ cyclesUsed: 1 }) }),
      );
    });
  });

  it("does NOT detach a single-cycle coupon — Stripe's `once` already removed it", async () => {
    redemptionFindFirst.mockResolvedValue(
      redemption({ cyclesUsed: 0, coupon: coupon({ durationCycles: 1 }) }),
    );
    await consumeCycle("u1", "sub_1", new Date("2026-09-01"));
    expect(detachDiscount).not.toHaveBeenCalled();
  });

  it("is idempotent per period — the webhook an early renewal triggers can't double-count", async () => {
    const periodEnd = new Date("2026-09-01T00:00:00Z");
    redemptionFindFirst.mockResolvedValue(
      redemption({ cyclesUsed: 1, lastCountedPeriodEnd: periodEnd }),
    );
    await consumeCycle("u1", "sub_1", new Date(periodEnd.getTime() + 60_000));
    expect(redemptionUpdate).not.toHaveBeenCalled();
  });

  it("counts a genuinely later renewal, which carries a different period end", async () => {
    redemptionFindFirst.mockResolvedValue(
      redemption({ cyclesUsed: 1, lastCountedPeriodEnd: new Date("2026-09-01") }),
    );
    await consumeCycle("u1", "sub_1", new Date("2026-10-01"));
    expect(redemptionUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ cyclesUsed: 2 }) }),
    );
  });

  it("does nothing when the user has no live discount", async () => {
    redemptionFindFirst.mockResolvedValue(null);
    await consumeCycle("u1", "sub_1", new Date());
    expect(redemptionUpdate).not.toHaveBeenCalled();
  });
});

describe("activateRedemption", () => {
  const couponCreate = fake.couponRedemption.create as unknown as ReturnType<typeof vi.fn>;

  it("does nothing when there's no reservation and no discount to recover", async () => {
    redemptionFindFirst.mockResolvedValue(null);
    getAttached.mockResolvedValue(null);
    await activateRedemption("u1", "sub_1");
    expect(prisma.coupon.update).not.toHaveBeenCalled();
  });

  it("recovers the record when the checkout outlasted the sweep window", async () => {
    // Declined card, customer took 30+ minutes to replace it, sweep binned the
    // reservation — but Stripe still discounted the invoice they just paid.
    redemptionFindFirst.mockResolvedValue(null);
    getAttached.mockResolvedValue("co_stripe");
    couponFindFirst.mockResolvedValue(coupon());
    redemptionFindUnique.mockResolvedValue(null); // no prior row for this user
    couponCreate.mockResolvedValue(redemption({ status: "pending" }));

    await activateRedemption("u1", "sub_1");

    expect(couponCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ couponId: "c1", userId: "u1", status: "pending" }),
      }),
    );
    // ...and it counts as a real redemption against the supply.
    expect(prisma.coupon.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { redeemedCount: { increment: 1 } } }),
    );
  });

  it("never resurrects a coupon the user has already finished with", async () => {
    redemptionFindFirst.mockResolvedValue(null);
    getAttached.mockResolvedValue("co_stripe");
    couponFindFirst.mockResolvedValue(coupon());
    redemptionFindUnique.mockResolvedValue(redemption({ status: "exhausted" }));

    await activateRedemption("u1", "sub_1");

    expect(couponCreate).not.toHaveBeenCalled();
    expect(prisma.coupon.update).not.toHaveBeenCalled();
  });

  it("ignores a discount applied by hand in the Stripe dashboard", async () => {
    redemptionFindFirst.mockResolvedValue(null);
    getAttached.mockResolvedValue("co_not_ours");
    couponFindFirst.mockResolvedValue(null);
    await activateRedemption("u1", "sub_1");
    expect(couponCreate).not.toHaveBeenCalled();
  });
});

describe("grantCoupon — admin grant guards", () => {
  const args = ["u1", "c1", "admin1"] as const;

  beforeEach(() => {
    couponFindUnique.mockResolvedValue(coupon());
    redemptionFindUnique.mockResolvedValue(null);
    profileFindUnique.mockResolvedValue({ stripeSubscriptionId: "sub_1", subscriptionPlanId: "p1" });
    redemptionFindFirst.mockResolvedValue(null);
  });

  it("rejects a coupon that no longer exists", async () => {
    couponFindUnique.mockResolvedValue(null);
    expect(await grantCoupon(...args)).toEqual({ ok: false, reason: "coupon_not_found" });
  });

  it("rejects a DEACTIVATED coupon — granting one would quietly resurrect it", async () => {
    couponFindUnique.mockResolvedValue(coupon({ active: false }));
    expect(await grantCoupon(...args)).toEqual({ ok: false, reason: "inactive" });
  });

  it("honours the redemption cap — a grant counts like any other redemption", async () => {
    couponFindUnique.mockResolvedValue(coupon({ maxRedemptions: 5, redeemedCount: 5 }));
    expect(await grantCoupon(...args)).toEqual({ ok: false, reason: "sold_out" });
  });

  it("rejects a coupon this customer already used", async () => {
    redemptionFindUnique.mockResolvedValue(redemption({ status: "exhausted" }));
    expect(await grantCoupon(...args)).toEqual({ ok: false, reason: "already_used" });
  });

  it("rejects a percentage coupon when the customer has no subscription", async () => {
    profileFindUnique.mockResolvedValue({ stripeSubscriptionId: null, subscriptionPlanId: null });
    expect(await grantCoupon(...args)).toEqual({ ok: false, reason: "no_subscription" });
  });

  it("allows a bonus-minutes coupon with no subscription — nothing to attach to Stripe", async () => {
    couponFindUnique.mockResolvedValue(coupon({ percentOff: null, bonusMinutes: 200 }));
    profileFindUnique.mockResolvedValue({ stripeSubscriptionId: null, subscriptionPlanId: null });
    (fake.couponRedemption.create as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(
      redemption({ status: "active" }),
    );
    expect(await grantCoupon(...args)).toEqual({ ok: true });
  });

  // The redemption window binds admins too, as an override rather than a wall: comping a lapsed
  // offer deliberately is fine, doing it by accident is not.
  const PAST = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const FUTURE = new Date(Date.now() + 24 * 60 * 60 * 1000);

  it("refuses an EXPIRED coupon unless the override is asked for", async () => {
    couponFindUnique.mockResolvedValue(coupon({ expiresAt: PAST }));
    expect(await grantCoupon(...args)).toEqual({ ok: false, reason: "expired" });
    expect(fake.couponRedemption.create).not.toHaveBeenCalled();
  });

  it("refuses a coupon whose window hasn't opened yet", async () => {
    couponFindUnique.mockResolvedValue(coupon({ startsAt: FUTURE }));
    expect(await grantCoupon(...args)).toEqual({ ok: false, reason: "not_started" });
  });

  /* A STARTER-only coupon could be granted to a customer on any other plan —
   * the restriction was enforced at checkout and nowhere else. */
  it("refuses a coupon restricted to plans this customer isn't on", async () => {
    couponFindUnique.mockResolvedValue(coupon({ planIds: ["p-starter"] }));
    expect(await grantCoupon(...args)).toEqual({ ok: false, reason: "plan_not_eligible" });
    expect(fake.couponRedemption.create).not.toHaveBeenCalled();
  });

  it("refuses a plan-restricted coupon when the customer has no plan at all", async () => {
    couponFindUnique.mockResolvedValue(coupon({ planIds: ["p-starter"] }));
    profileFindUnique.mockResolvedValue({ stripeSubscriptionId: "sub_1", subscriptionPlanId: null });
    expect(await grantCoupon(...args)).toEqual({ ok: false, reason: "plan_not_eligible" });
  });

  it("allows a plan-restricted coupon for a customer who IS on that plan", async () => {
    couponFindUnique.mockResolvedValue(coupon({ planIds: ["p1", "p-other"] }));
    (fake.couponRedemption.create as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(
      redemption({ status: "active" }),
    );
    expect(await grantCoupon(...args)).toEqual({ ok: true });
  });

  it("grants a plan-restricted coupon when the override is explicit", async () => {
    couponFindUnique.mockResolvedValue(coupon({ planIds: ["p-starter"] }));
    (fake.couponRedemption.create as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(
      redemption({ status: "active" }),
    );
    expect(await grantCoupon("u1", "c1", "admin1", { override: true })).toEqual({ ok: true });
  });

  it("grants an expired coupon when the override is explicit", async () => {
    couponFindUnique.mockResolvedValue(coupon({ expiresAt: PAST }));
    (fake.couponRedemption.create as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(
      redemption({ status: "active" }),
    );
    expect(await grantCoupon("u1", "c1", "admin1", { override: true })).toEqual({ ok: true });
  });

  it("still applies every other guard under an override — it waives the window only", async () => {
    couponFindUnique.mockResolvedValue(coupon({ expiresAt: PAST, active: false }));
    expect(await grantCoupon("u1", "c1", "admin1", { override: true })).toEqual({
      ok: false,
      reason: "inactive",
    });
  });

  it("overwrites an unfinished checkout — an admin grant supersedes a reservation", async () => {
    redemptionFindUnique.mockResolvedValue(redemption({ status: "pending" }));
    (fake.couponRedemption.create as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(
      redemption({ status: "active" }),
    );
    expect(await grantCoupon(...args)).toEqual({ ok: true });
  });
});

describe("grantableCoupons — what the admin picker renders", () => {
  const couponFindMany = prisma.coupon.findMany as unknown as ReturnType<typeof vi.fn>;
  const redemptionFindMany = fake.couponRedemption.findMany as unknown as ReturnType<typeof vi.fn>;

  beforeEach(() => {
    couponFindMany.mockResolvedValue([coupon()]);
    redemptionFindMany.mockResolvedValue([]);
    profileFindUnique.mockResolvedValue({ stripeSubscriptionId: "sub_1", subscriptionPlanId: "p1" });
  });

  it("marks a clean coupon eligible with nothing to warn about", async () => {
    const [c] = await grantableCoupons("u1");
    expect(c.eligible).toBe(true);
    expect(c.reason).toBeNull();
    expect(c.warning).toBeNull();
  });

  it("blocks one the customer already used, with the reason shown", async () => {
    redemptionFindMany.mockResolvedValue([{ couponId: "c1", status: "exhausted" }]);
    const [c] = await grantableCoupons("u1");
    expect(c.eligible).toBe(false);
    expect(c.reason).toMatch(/already used/i);
  });

  it("does NOT block on a bare reservation — that checkout never finished", async () => {
    redemptionFindMany.mockResolvedValue([{ couponId: "c1", status: "pending" }]);
    expect((await grantableCoupons("u1"))[0].eligible).toBe(true);
  });

  it("blocks a sold-out coupon", async () => {
    couponFindMany.mockResolvedValue([coupon({ maxRedemptions: 2, redeemedCount: 2 })]);
    const [c] = await grantableCoupons("u1");
    expect(c.eligible).toBe(false);
    expect(c.reason).toMatch(/limit/i);
  });

  it("blocks a percentage coupon when there's no subscription to attach it to", async () => {
    profileFindUnique.mockResolvedValue({ stripeSubscriptionId: null, subscriptionPlanId: null });
    const [c] = await grantableCoupons("u1");
    expect(c.eligible).toBe(false);
    expect(c.reason).toMatch(/no subscription/i);
  });

  it("gates a plan-restricted coupon behind the override instead of hiding the option", async () => {
    couponFindMany.mockResolvedValue([coupon({ planIds: ["p-other"] })]);
    const [c] = await grantableCoupons("u1");
    // Not a hard blocker — an admin may comp it — but the button waits.
    expect(c.eligible).toBe(true);
    expect(c.requiresOverride).toBe(true);
    expect(c.restrictions).toEqual(["plan_not_eligible"]);
    expect(c.warning).toMatch(/limited to other plans/i);
  });

  it("leaves an unrestricted coupon alone — every plan qualifies", async () => {
    couponFindMany.mockResolvedValue([coupon({ planIds: [] })]);
    const [c] = await grantableCoupons("u1");
    expect(c.requiresOverride).toBe(false);
  });

  it("asks for nothing when the customer is on one of the coupon's plans", async () => {
    couponFindMany.mockResolvedValue([coupon({ planIds: ["p1"] })]);
    const [c] = await grantableCoupons("u1");
    expect(c.requiresOverride).toBe(false);
    expect(c.warning).toBeNull();
  });

  it("flags an expired coupon as needing an explicit override, and dates the warning", async () => {
    const expiresAt = new Date(Date.now() - 24 * 60 * 60 * 1000);
    couponFindMany.mockResolvedValue([coupon({ expiresAt })]);
    const [c] = await grantableCoupons("u1");
    // Still grantable — but the button waits for a tick, and the admin is told why.
    expect(c.eligible).toBe(true);
    expect(c.requiresOverride).toBe(true);
    expect(c.warning).toMatch(/expired/i);
    expect(c.windowEndsAt).toBe(expiresAt.toISOString());
  });

  it("flags one whose window hasn't opened yet, pointing at the start date", async () => {
    const startsAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
    couponFindMany.mockResolvedValue([coupon({ startsAt })]);
    const [c] = await grantableCoupons("u1");
    expect(c.requiresOverride).toBe(true);
    expect(c.windowEndsAt).toBe(startsAt.toISOString());
  });

  it("carries both warnings when a coupon is expired AND for another plan", async () => {
    couponFindMany.mockResolvedValue([
      coupon({ expiresAt: new Date(Date.now() - 1000), planIds: ["p-other"] }),
    ]);
    const [c] = await grantableCoupons("u1");
    expect(c.restrictions).toEqual(["expired", "plan_not_eligible"]);
    expect(c.warning).toMatch(/expired/i);
    expect(c.warning).toMatch(/limited to other plans/i);
  });

  it("asks for no override on a coupon inside its window", async () => {
    couponFindMany.mockResolvedValue([
      coupon({
        startsAt: new Date(Date.now() - 1000),
        expiresAt: new Date(Date.now() + 60_000),
      }),
    ]);
    const [c] = await grantableCoupons("u1");
    expect(c.requiresOverride).toBe(false);
    expect(c.warning).toBeNull();
  });

  it("says nothing about the window on a coupon that's blocked outright", async () => {
    // The reason is what matters there; a warning as well is just noise.
    couponFindMany.mockResolvedValue([
      coupon({ expiresAt: new Date(Date.now() - 1000), maxRedemptions: 1, redeemedCount: 1 }),
    ]);
    const [c] = await grantableCoupons("u1");
    expect(c.eligible).toBe(false);
    expect(c.requiresOverride).toBe(false);
    expect(c.warning).toBeNull();
  });
});

// The commonest campaign shape ("first month half price"), where a mistake is invisible until a
// customer notices they're still discounted months later.
describe("a 1-cycle coupon: discounted once, then full price", () => {
  const oneCycle = coupon({ durationCycles: 1, bonusMinutes: 200 });

  it("retires after the FIRST charge, and doesn't ask Stripe to detach", async () => {
    redemptionFindFirst.mockResolvedValue(redemption({ cyclesUsed: 0, coupon: oneCycle }));

    await consumeCycle("u1", "sub_1", new Date("2026-09-01"));

    expect(redemptionUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: "exhausted", cyclesUsed: 1 }),
      }),
    );
    expect(detachDiscount).not.toHaveBeenCalled(); // Stripe's `once` already did it
    expect(attachDiscount).not.toHaveBeenCalled(); // and nothing puts it back
  });

  it("stops adding bonus minutes from the second cycle", async () => {
    // Cycle 1 — the coupon is live, so the bonus counts.
    redemptionFindFirst.mockResolvedValue(redemption({ coupon: oneCycle }));
    expect(await effectiveIncludedMinutes("u1", 500)).toBe(700);

    // Cycle 2 — retired, so `getActiveRedemption` finds nothing.
    redemptionFindFirst.mockResolvedValue(null);
    expect(await effectiveIncludedMinutes("u1", 500)).toBe(500);
  });

  it("can't be redeemed again by the same customer", async () => {
    couponFindUnique.mockResolvedValue(oneCycle);
    redemptionFindUnique.mockResolvedValue(redemption({ status: "exhausted" }));
    planEventFindFirst.mockResolvedValue(null);
    const res = await validateCoupon({ code: "HALFOFF", userId: "u1", planId: "p1" });
    expect(res).toEqual({ ok: false, reason: "already_used" });
  });
});

describe("effectiveIncludedMinutes", () => {
  it("adds the coupon's bonus on top of the plan allowance", async () => {
    redemptionFindFirst.mockResolvedValue(
      redemption({ coupon: coupon({ bonusMinutes: 200 }) }),
    );
    expect(await effectiveIncludedMinutes("u1", 500)).toBe(700);
  });

  it("leaves the allowance alone when the coupon is percentage-only", async () => {
    redemptionFindFirst.mockResolvedValue(redemption());
    expect(await effectiveIncludedMinutes("u1", 500)).toBe(500);
  });

  it("leaves an UNLIMITED plan unlimited — 0 is not an allowance to add to", async () => {
    redemptionFindFirst.mockResolvedValue(
      redemption({ coupon: coupon({ bonusMinutes: 200 }) }),
    );
    expect(await effectiveIncludedMinutes("u1", 0)).toBe(0);
  });

  it("returns the plan allowance untouched with no live discount", async () => {
    redemptionFindFirst.mockResolvedValue(null);
    expect(await effectiveIncludedMinutes("u1", 500)).toBe(500);
  });
});

// ONE LIVE DISCOUNT PER ACCOUNT. The schema can't enforce it (the unique only blocks the SAME coupon
// twice), so every read resolves through the single-valued Profile.activeCouponRedemptionId.
describe("coupon stacking is impossible", () => {
  const redemptionUpdateMany = fake.couponRedemption
    .updateMany as unknown as ReturnType<typeof vi.fn>;
  const redemptionCreate = fake.couponRedemption.create as unknown as ReturnType<typeof vi.fn>;
  const profileUpdate = fake.profile.update as unknown as ReturnType<typeof vi.fn>;

  /** grantCoupon reads back the row it creates, so the mock has to return one. */
  const grantSetup = (couponOver: Record<string, unknown> = {}) => {
    couponFindUnique.mockResolvedValue(coupon(couponOver));
    redemptionFindUnique.mockResolvedValue(null);
    redemptionCreate.mockResolvedValue({ id: "r_granted" });
    profileFindUnique.mockResolvedValue({
      stripeSubscriptionId: "sub_1",
      subscriptionPlanId: "p1",
      activeCouponRedemptionId: null,
    });
  };

  it("resolves the live discount through the profile pointer, not a status scan", async () => {
    profileFindUnique.mockResolvedValue({
      stripeSubscriptionId: "sub_1",
      activeCouponRedemptionId: "r_pointed",
    });
    redemptionFindUnique.mockResolvedValue(
      redemption({ id: "r_pointed", userId: "u1", coupon: coupon({ code: "POINTED" }) }),
    );

    const live = await getActiveRedemption("u1");

    expect(live?.id).toBe("r_pointed");
    // The scan is the fallback, not the answer.
    expect(redemptionFindFirst).not.toHaveBeenCalled();
  });

  it("picks exactly ONE discount when two rows are somehow both active", async () => {
    // The pointer decides. Without it, an unordered findFirst would return an
    // arbitrary row and leave the other as a ghost that no cycle ever counts.
    profileFindUnique.mockResolvedValue({
      stripeSubscriptionId: "sub_1",
      activeCouponRedemptionId: "r_b",
    });
    redemptionFindUnique.mockResolvedValue(
      redemption({ id: "r_b", userId: "u1", coupon: coupon({ code: "B", percentOff: 10 }) }),
    );

    const live = await getActiveRedemption("u1");

    expect(live?.coupon.code).toBe("B");
    expect(live?.coupon.percentOff).toBe(10);
  });

  it("ignores a pointer that no longer names a live row", async () => {
    // Retired/revoked/deleted → fall through rather than report a dead discount.
    profileFindUnique.mockResolvedValue({
      stripeSubscriptionId: "sub_1",
      activeCouponRedemptionId: "r_stale",
    });
    redemptionFindUnique.mockResolvedValue(
      redemption({ id: "r_stale", userId: "u1", status: "exhausted" }),
    );
    redemptionFindFirst.mockResolvedValue(null);

    expect(await getActiveRedemption("u1")).toBeNull();
  });

  it("still finds a live discount when the pointer is missing, and heals it", async () => {
    // Losing the pointer must not hide a running discount: Stripe would keep
    // applying it with nothing left to count its cycles or retire it.
    profileFindUnique.mockResolvedValue({
      stripeSubscriptionId: "sub_1",
      activeCouponRedemptionId: null,
    });
    redemptionFindFirst.mockResolvedValue(redemption({ id: "r_orphan", userId: "u1" }));

    const live = await getActiveRedemption("u1");

    expect(live?.id).toBe("r_orphan");
    expect(profileUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ data: { activeCouponRedemptionId: "r_orphan" } }),
    );
  });

  it("revokes EVERY active row when a new coupon is redeemed, in one transaction", async () => {
    redemptionFindFirst.mockResolvedValue(redemption({ id: "r_new", status: "pending" }));

    await activateRedemption("u1", "sub_1");

    // updateMany, not a single-row update: a collision already in the data has to
    // be cleaned up here rather than preserved.
    expect(redemptionUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId: "u1", status: "active" },
        data: expect.objectContaining({ status: "revoked" }),
      }),
    );
    // One transaction — revoke and activate cannot be interleaved by a second caller.
    expect(transaction).toHaveBeenCalledTimes(1);
  });

  it("revokes EVERY active row when an admin grants a coupon", async () => {
    grantSetup();

    await grantCoupon("u1", "c1", "admin1");

    expect(redemptionUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId: "u1", status: "active" },
        data: expect.objectContaining({ status: "revoked" }),
      }),
    );
  });

  it("clears a money discount when a bonus-minutes coupon takes over", async () => {
    // A bonus-only coupon has no Stripe object to replace the old percentage, so it must be detached
    // explicitly or the customer keeps paying less under a redemption nothing will retire.
    grantSetup({ percentOff: null, bonusMinutes: 500, stripeCouponId: null });
    getAttached.mockResolvedValue("co_previous");

    await grantCoupon("u1", "c1", "admin1");

    expect(detachDiscount).toHaveBeenCalledWith("sub_1");
  });

  it("refuses a SECOND code while a discount is already running", async () => {
    // /subscribe applies the requested code straight to Stripe and only cleans up pending rows, so without
    // this the sub would bill under the new code while we still counted cycles for the old one.
    couponFindUnique.mockResolvedValue(coupon({ id: "c_new", code: "SECOND" }));
    redemptionFindUnique.mockResolvedValue(null); // never redeemed THIS code
    profileFindUnique.mockResolvedValue({
      stripeSubscriptionId: "sub_1",
      activeCouponRedemptionId: "r_live",
    });
    redemptionFindUnique.mockResolvedValueOnce(null);
    const findUniqueForPointer = redemption({ id: "r_live", couponId: "c_old", userId: "u1" });
    redemptionFindUnique.mockResolvedValue(findUniqueForPointer);

    const result = await validateCoupon({ code: "SECOND", userId: "u1", planId: "p1" });

    expect(result).toEqual({ ok: false, reason: "already_discounted" });
  });

  it("still accepts the code the user already has running (re-entry is judged elsewhere)", async () => {
    couponFindUnique.mockResolvedValue(coupon({ id: "c1" }));
    redemptionFindUnique.mockResolvedValueOnce(null); // no completed row for this code
    profileFindUnique.mockResolvedValue({
      stripeSubscriptionId: "sub_1",
      activeCouponRedemptionId: "r_live",
    });
    redemptionFindUnique.mockResolvedValue(redemption({ id: "r_live", couponId: "c1" }));

    const result = await validateCoupon({ code: "LAUNCH30", userId: "u1", planId: "p1" });

    expect(result.ok).toBe(true);
  });

  it("locks the profile row before deciding the live discount", async () => {
    // Prisma runs at READ COMMITTED, so without a lock two writers can each see
    // nothing to revoke and both commit an active row.
    const executeRaw = prisma.$executeRaw as unknown as ReturnType<typeof vi.fn>;
    redemptionFindFirst.mockResolvedValue(redemption({ id: "r_new", status: "pending" }));

    await activateRedemption("u1", "sub_1");

    expect(executeRaw).toHaveBeenCalled();
  });

  it("retires siblings when it heals a collided state, instead of leaving them", async () => {
    // Healing the pointer alone would leave the loser for a later pointer-null
    // read to pick up — a superseded coupon coming back to life months on.
    profileFindUnique.mockResolvedValue({
      stripeSubscriptionId: "sub_1",
      activeCouponRedemptionId: null,
    });
    redemptionFindFirst.mockResolvedValue(redemption({ id: "r_winner", userId: "u1" }));

    await getActiveRedemption("u1");

    expect(redemptionUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          userId: "u1",
          status: "active",
          id: { not: "r_winner" },
        }),
      }),
    );
  });

  it("mirrors a discount change onto a pending downgrade schedule", async () => {
    // scheduleDowngrade freezes whatever coupon was attached when it ran and
    // re-applies it at the period boundary, on top of the replacement.
    grantSetup();
    profileFindUnique.mockResolvedValue({
      stripeSubscriptionId: "sub_1",
      subscriptionPlanId: "p1",
      activeCouponRedemptionId: null,
      stripeScheduleId: "sched_1",
    });

    await grantCoupon("u1", "c1", "admin1");

    expect(setSchedulePhaseDiscounts).toHaveBeenCalledWith("sched_1", "co_stripe");
  });

  it("replaces a DIFFERENT discount Stripe is carrying, rather than leaving it", async () => {
    // Being billed under one coupon while we count cycles against another means
    // neither ever behaves correctly.
    redemptionFindFirst.mockResolvedValue(redemption({ cyclesUsed: 0 }));
    getAttached.mockResolvedValue("co_someone_elses");

    await consumeCycle("u1", "sub_1", new Date("2026-09-01"), "in_1");

    expect(attachDiscount).toHaveBeenCalledWith("sub_1", "co_stripe");
  });
});

// Deploy-order insurance: coupon reads sit in paths every customer hits, so a database the migration
// hasn't reached must make the feature inert rather than 500 everyone.
describe("database without the coupon tables (P2021)", () => {
  const missingTable = Object.assign(new Error("table does not exist"), { code: "P2021" });

  it("reports no active discount instead of throwing", async () => {
    redemptionFindFirst.mockRejectedValue(missingTable);
    expect(await getActiveRedemption("u1")).toBeNull();
  });

  it("leaves the plan's minute allowance exactly as it was", async () => {
    redemptionFindFirst.mockRejectedValue(missingTable);
    expect(await effectiveIncludedMinutes("u1", 500)).toBe(500);
  });

  it("makes cycle counting a no-op, so renewals are untouched", async () => {
    redemptionFindFirst.mockRejectedValue(missingTable);
    await consumeCycle("u1", "sub_1", new Date());
    expect(redemptionUpdate).not.toHaveBeenCalled();
  });

  it("treats every code as unknown rather than erroring at checkout", async () => {
    couponFindUnique.mockRejectedValue(missingTable);
    expect(await validateCoupon({ code: "X", userId: "u1", planId: "p1" })).toEqual({
      ok: false,
      reason: "not_found",
    });
  });

  it("still surfaces REAL database errors", async () => {
    redemptionFindFirst.mockRejectedValue(
      Object.assign(new Error("connection lost"), { code: "P1001" }),
    );
    await expect(getActiveRedemption("u1")).rejects.toThrow(/connection lost/);
  });
});

describe("healDiscountDrift", () => {
  // Runs from reconcileSubscription on EVERY gated request — a Stripe call here for users who never
  // held a coupon would add a network round-trip to every request the customer base makes.
  it("never touches Stripe for a user who has never held a coupon", async () => {
    redemptionFindFirst.mockResolvedValue(null); // no ended redemption
    await healDiscountDrift("u1", "sub_1");
    expect(getAttached).not.toHaveBeenCalled();
    expect(detachDiscount).not.toHaveBeenCalled();
  });

  it("detaches one of our discounts left attached after the budget was spent", async () => {
    redemptionFindFirst
      .mockResolvedValueOnce({ id: "r-old" }) // they DID once hold one that ended
      .mockResolvedValueOnce(null); // ...and nothing is live now
    getAttached.mockResolvedValue("co_stripe");
    couponFindFirst.mockResolvedValue({ id: "c1" }); // it's ours
    await healDiscountDrift("u1", "sub_1");
    expect(detachDiscount).toHaveBeenCalledWith("sub_1");
  });

  it("leaves a live discount alone", async () => {
    redemptionFindFirst
      .mockResolvedValueOnce({ id: "r-old" })
      .mockResolvedValueOnce(redemption()); // still running
    await healDiscountDrift("u1", "sub_1");
    expect(detachDiscount).not.toHaveBeenCalled();
  });

  it("never touches a coupon applied by hand in the Stripe dashboard", async () => {
    redemptionFindFirst.mockResolvedValueOnce({ id: "r-old" }).mockResolvedValueOnce(null);
    getAttached.mockResolvedValue("co_someone_elses");
    couponFindFirst.mockResolvedValue(null); // not one of ours
    await healDiscountDrift("u1", "sub_1");
    expect(detachDiscount).not.toHaveBeenCalled();
  });
});

describe("syncStripeCoupon", () => {
  const base = { code: "X", displayName: "X", stripeCouponId: null };

  it("uses Stripe's `once` for a single-cycle coupon, so Stripe retires it itself", async () => {
    const { createStripeCoupon } = await import("./stripe.js");
    await syncStripeCoupon({ ...base, percentOff: 50, durationCycles: 1 });
    expect(createStripeCoupon).toHaveBeenCalledWith(
      expect.objectContaining({ duration: "once" }),
    );
  });

  it("uses `forever` for a multi-cycle coupon — WE count the cycles", async () => {
    const { createStripeCoupon } = await import("./stripe.js");
    await syncStripeCoupon({ ...base, percentOff: 50, durationCycles: 3 });
    expect(createStripeCoupon).toHaveBeenCalledWith(
      expect.objectContaining({ duration: "forever" }),
    );
  });

  it("creates nothing in Stripe for a bonus-minutes-only coupon", async () => {
    const { createStripeCoupon } = await import("./stripe.js");
    const result = await syncStripeCoupon({ ...base, percentOff: null, durationCycles: 2 });
    expect(createStripeCoupon).not.toHaveBeenCalled();
    expect(result.stripeCouponId).toBeNull();
  });
});
