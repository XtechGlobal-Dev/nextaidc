import type { Coupon } from "@prisma/client";
import type { CouponRedemption } from "@prisma/tenant-client";
import { prisma } from "../prisma.js";
import { allTenants, tenantForUser, TenantUnavailableError, type TenantClient } from "./tenantDb.js";
import {
  attachSubscriptionDiscount,
  createStripeCoupon,
  deleteStripeCoupon,
  detachSubscriptionDiscount,
  getSubscriptionDiscountCouponId,
  isStripeConfigured,
  setSchedulePhaseDiscounts,
  type StripeCouponDuration,
} from "./stripe.js";
import { recordPlanEvent } from "./planHistory.js";

// Coupons span two databases: the COUPON catalogue is in the control plane, each REDEMPTION in the customer's brand DB.
// So `coupon` is joined by hand (withCoupon), redeemedCount is a second write after the tenant tx, and live reservations are summed across tenants.

/** How long a checkout may hold a reservation before the hourly sweep frees it. */
export const PENDING_RESERVATION_TTL_MS = 30 * 60 * 1000;

/** Plan events that prove an account has held a paid plan at some point. */
const PAID_PLAN_EVENT_TYPES = ["trial_converted", "renewed", "upgraded"];

/** Codes are stored and compared uppercase, so entry is case-insensitive. */
export function normalizeCode(raw: string): string {
  return raw.trim().toUpperCase();
}

// Row-lock the profile so a concurrent activate and grant can't both read "no live discount" and both apply.
async function lockUserCouponState(
  tx: { $executeRaw: (q: TemplateStringsArray, ...v: unknown[]) => Promise<number> },
  userId: string,
): Promise<void> {
  await tx.$executeRaw`SELECT 1 FROM profiles WHERE "userId" = ${userId} FOR UPDATE`;
}

/** A deployment whose migrations haven't created the coupon tables yet
 *  should behave as "no coupons", not fail every checkout. */
function isMissingCouponTable(e: unknown): boolean {
  return typeof e === "object" && e !== null && (e as { code?: unknown }).code === "P2021";
}

export type Redemption = CouponRedemption & { coupon: Coupon };

/** The catalogue row a redemption names — in the control plane, so joined by
 *  hand. A redemption whose coupon is gone from the catalogue reads as none. */
async function withCoupon<T extends { couponId: string }>(r: T | null): Promise<(T & { coupon: Coupon }) | null> {
  if (!r) return null;
  // A row that already carries its coupon (joined by a caller) needs no second read.
  const carried = (r as { coupon?: Coupon | null }).coupon;
  if (carried) return { ...r, coupon: carried };
  const coupon = await prisma.coupon.findUnique({ where: { id: r.couponId } });
  return coupon ? { ...r, coupon } : null;
}

export type CouponRejection =
  | "not_found"
  | "inactive"
  | "not_started"
  | "expired"
  | "sold_out"
  | "already_used"
  | "already_discounted"
  | "not_new_customer"
  | "plan_not_eligible"
  | "stripe_unavailable";

/** Customer-facing copy per rejection. Deliberately vague about whether an
 *  unknown code exists at all. */
const REJECTION_MESSAGE: Record<CouponRejection, string> = {
  not_found: "That code isn't valid.",
  inactive: "That code isn't valid.",
  not_started: "That code isn't active yet.",
  expired: "That code has expired.",
  sold_out: "That code has been fully claimed.",
  already_used: "You've already used that code.",
  already_discounted: "You already have a discount running on this account.",
  not_new_customer: "That code is only for new customers.",
  plan_not_eligible: "That code doesn't apply to the plan you picked.",
  stripe_unavailable: "Discount codes aren't available right now.",
};

export function rejectionMessage(reason: CouponRejection): string {
  return REJECTION_MESSAGE[reason];
}

export type CouponValidation = { ok: true; coupon: Coupon } | { ok: false; reason: CouponRejection };

/** Reservations still holding a slot (created inside the TTL). */
function livePendingWhere(couponId: string, cutoff = new Date(Date.now() - PENDING_RESERVATION_TTL_MS)) {
  return { couponId, status: "pending", reservedAt: { gt: cutoff } } as const;
}

/** Live reservations for a coupon across every brand's database. */
async function livePendingCount(couponId: string, cutoff?: Date): Promise<number> {
  let n = 0;
  for (const { db } of await allTenants()) {
    n += await db.couponRedemption.count({ where: livePendingWhere(couponId, cutoff) });
  }
  return n;
}

/** Bump the catalogue's tally — the control plane's side of a redemption. */
async function countRedeemed(couponId: string, delta: number): Promise<void> {
  await prisma.coupon.update({ where: { id: couponId }, data: { redeemedCount: { increment: delta } } });
}

async function hasEverPaid(userId: string): Promise<boolean> {
  const db = await tenantForUser(userId);
  const seen = await db.planEvent.findFirst({
    where: { userId, type: { in: PAID_PLAN_EVENT_TYPES } },
    select: { id: true },
  });
  return !!seen;
}

export function redemptionWindow(
  coupon: { startsAt: Date | null; expiresAt: Date | null },
  now = new Date(),
): "open" | "not_started" | "expired" {
  if (coupon.startsAt && coupon.startsAt > now) return "not_started";
  if (coupon.expiresAt && coupon.expiresAt <= now) return "expired";
  return "open";
}

/* ------------------------------ Checkout ------------------------------ */

export async function validateCoupon(input: {
  code: string;
  userId: string;
  planId: string;
}): Promise<CouponValidation> {
  const coupon = await prisma.coupon
    .findUnique({ where: { code: normalizeCode(input.code) } })
    .catch((e: unknown) => {
      if (isMissingCouponTable(e)) return null;
      throw e;
    });
  if (!coupon) return { ok: false, reason: "not_found" };
  if (!coupon.active) return { ok: false, reason: "inactive" };
  const window = redemptionWindow(coupon);
  if (window !== "open") return { ok: false, reason: window };
  if (coupon.percentOff && !isStripeConfigured()) {
    return { ok: false, reason: "stripe_unavailable" };
  }
  if (coupon.planIds.length > 0 && !coupon.planIds.includes(input.planId)) {
    return { ok: false, reason: "plan_not_eligible" };
  }

  const db = await tenantForUser(input.userId);
  // A pending reservation of this user's own is the checkout they are
  // retrying, so it is let through; reserveRedemption reuses the row.
  const existing = await db.couponRedemption.findUnique({
    where: { couponId_userId: { couponId: coupon.id, userId: input.userId } },
  });
  if (existing && existing.status !== "pending") return { ok: false, reason: "already_used" };

  const live = await getActiveRedemption(input.userId);
  if (live && live.couponId !== coupon.id) return { ok: false, reason: "already_discounted" };

  if (coupon.maxRedemptions != null) {
    const pending = await livePendingCount(coupon.id);
    // Don't count this user's own live reservation against them.
    const ownLivePending = existing && existing.status === "pending" && !isStalePending(existing) ? 1 : 0;
    if (coupon.redeemedCount + pending - ownLivePending >= coupon.maxRedemptions) {
      return { ok: false, reason: "sold_out" };
    }
  }

  if (coupon.newCustomersOnly && (await hasEverPaid(input.userId))) {
    return { ok: false, reason: "not_new_customer" };
  }
  return { ok: true, coupon };
}

function isStalePending(r: CouponRedemption): boolean {
  return r.status === "pending" && r.reservedAt.getTime() <= Date.now() - PENDING_RESERVATION_TTL_MS;
}

/** Holds a slot for an imminent checkout. Idempotent per user — a retry reuses the row instead of tripping the unique key. */
export async function reserveRedemption(couponId: string, userId: string): Promise<CouponRedemption> {
  const cutoff = new Date(Date.now() - PENDING_RESERVATION_TTL_MS);
  const db = await tenantForUser(userId);
  const coupon = await prisma.coupon.findUnique({ where: { id: couponId } });
  if (!coupon) throw new Error("coupon not found");
  return db.$transaction(async (inBrand) => {
    // Clear the user's own stale reservation first, or the unique constraint rejects a legitimate retry until the hourly sweep.
    await inBrand.couponRedemption.deleteMany({
      where: { couponId, userId, status: "pending", reservedAt: { lte: cutoff } },
    });
    const existing = await inBrand.couponRedemption.findUnique({
      where: { couponId_userId: { couponId, userId } },
    });
    if (existing) return existing;
    if (coupon.maxRedemptions != null) {
      const pending = await livePendingCount(couponId, cutoff);
      if (coupon.redeemedCount + pending >= coupon.maxRedemptions) {
        throw new Error("coupon sold out");
      }
    }
    return inBrand.couponRedemption.create({ data: { couponId, userId, status: "pending" } });
  });
}

/** Turns the reservation into a live discount once the subscription starts. Any other live redemption is revoked — one discount at a time. */
export async function activateRedemption(userId: string, subscriptionId?: string | null): Promise<void> {
  const db = await tenantForUser(userId);
  let pending = await withCoupon(
    await db.couponRedemption.findFirst({ where: { userId, status: "pending" }, orderBy: { reservedAt: "desc" } }),
  );
  if (!pending && subscriptionId) {
    pending = await recoverRedemptionFromSubscription(db, userId, subscriptionId);
  }
  if (!pending) return;
  const applied = pending;

  await db.$transaction(async (inBrand) => {
    await lockUserCouponState(inBrand, userId);
    await inBrand.couponRedemption.updateMany({
      where: { userId, status: "active" },
      data: { status: "revoked", endedAt: new Date() },
    });
    await inBrand.couponRedemption.update({
      where: { id: applied.id },
      data: { status: "active", appliedAt: new Date() },
    });
    await inBrand.profile.update({ where: { userId }, data: { activeCouponRedemptionId: applied.id } });
  });
  // The catalogue's tally is in the control plane: a second database, a second write.
  await countRedeemed(applied.couponId, 1);

  await syncStripeDiscountTo(db, userId, subscriptionId ?? null, applied.coupon);
  void recordPlanEvent({
    userId,
    type: "coupon_applied",
    note: couponAppliedNote(applied.coupon),
  });
}

// Sub carries one of our Stripe coupons but the sweep freed its reservation: rebuild it so the discount is tracked.
async function recoverRedemptionFromSubscription(
  db: TenantClient,
  userId: string,
  subscriptionId: string,
): Promise<Redemption | null> {
  try {
    if (!isStripeConfigured()) return null;
    const attached = await getSubscriptionDiscountCouponId(subscriptionId);
    if (!attached) return null;
    const coupon = await prisma.coupon.findFirst({ where: { stripeCouponId: attached } });
    if (!coupon) return null;
    const prior = await db.couponRedemption.findUnique({
      where: { couponId_userId: { couponId: coupon.id, userId } },
    });
    if (prior) return null;
    const created = await db.couponRedemption.create({ data: { couponId: coupon.id, userId, status: "pending" } });
    return { ...created, coupon };
  } catch {
    return null;
  }
}

async function syncStripeDiscountTo(
  db: TenantClient,
  userId: string,
  subscriptionId: string | null,
  coupon: Coupon,
): Promise<void> {
  let subId = subscriptionId;
  if (!subId) {
    const profile = await db.profile.findUnique({ where: { userId }, select: { stripeSubscriptionId: true } });
    subId = profile?.stripeSubscriptionId ?? null;
  }
  if (!subId || !isStripeConfigured()) return;
  try {
    if (coupon.stripeCouponId) {
      await attachSubscriptionDiscount(subId, coupon.stripeCouponId);
    } else {
      const attached = await getSubscriptionDiscountCouponId(subId);
      if (attached) await detachSubscriptionDiscount(subId);
    }
    await mirrorDiscountOntoSchedule(db, userId, coupon.stripeCouponId ?? null);
  } catch {
    /* best-effort — healDiscountDrift repairs it on the next reconcile */
  }
}

/** A scheduled plan change carries the discount too, or the customer would
 *  lose it the day the new plan starts. */
async function mirrorDiscountOntoSchedule(db: TenantClient, userId: string, stripeCouponId: string | null): Promise<void> {
  const profile = await db.profile.findUnique({ where: { userId }, select: { stripeScheduleId: true } });
  if (!profile?.stripeScheduleId) return;
  await setSchedulePhaseDiscounts(profile.stripeScheduleId, stripeCouponId).catch(() => {
    /* schedule already released/completed, or Stripe hiccup — nothing to correct */
  });
}

function couponAppliedNote(coupon: Coupon): string {
  const parts: string[] = [];
  if (coupon.percentOff) parts.push(`${coupon.percentOff}% off`);
  if (coupon.bonusMinutes) parts.push(`+${coupon.bonusMinutes} bonus minutes`);
  const cycles = coupon.durationCycles === 1 ? "the first charge" : `${coupon.durationCycles} billing cycles`;
  return `Coupon ${coupon.code} applied — ${parts.join(" and ")} for ${cycles}`;
}

/* ------------------------------ Live state ------------------------------ */

/** The customer's live discount. The profile pointer is the fast path, a scan is the truth, and two live rows are healed on the way out. */
export async function getActiveRedemption(userId: string): Promise<Redemption | null> {
  try {
    const db = await tenantForUser(userId);
    const profile = await db.profile.findUnique({ where: { userId }, select: { activeCouponRedemptionId: true } });
    if (profile?.activeCouponRedemptionId) {
      const pointed = await db.couponRedemption.findUnique({ where: { id: profile.activeCouponRedemptionId } });
      if (pointed && pointed.userId === userId && pointed.status === "active") return withCoupon(pointed);
    }
    const scanned = await db.couponRedemption.findFirst({
      where: { userId, status: "active" },
      // Deterministic: if rows ever did collide, the newest is the one the
      // customer most recently redeemed, and the one Stripe will be carrying.
      orderBy: { appliedAt: "desc" },
    });
    if (!scanned) return null;
    await db
      .$transaction([
        db.couponRedemption.updateMany({
          where: { userId, status: "active", id: { not: scanned.id } },
          data: { status: "revoked", endedAt: new Date() },
        }),
        db.profile.update({ where: { userId }, data: { activeCouponRedemptionId: scanned.id } }),
      ])
      .catch(() => {
        /* best-effort heal — the scan already answered the question */
      });
    return withCoupon(scanned);
  } catch (e) {
    if (isMissingCouponTable(e)) return null;
    // The platform's own people have no brand — and hold no coupons.
    if (e instanceof TenantUnavailableError) return null;
    throw e;
  }
}

/** Drop every other reservation this user holds — a checkout that switched
 *  codes must not leave the first one blocking a slot. */
export async function clearOtherPendingReservations(userId: string, keepCouponId?: string | null): Promise<void> {
  try {
    const db = await tenantForUser(userId);
    await db.couponRedemption.deleteMany({
      where: {
        userId,
        status: "pending",
        ...(keepCouponId ? { couponId: { not: keepCouponId } } : {}),
      },
    });
  } catch (e) {
    if (!isMissingCouponTable(e)) throw e;
  }
}

/** Two period ends within an hour describe the same cycle (the tolerance
 *  covers Stripe's own rounding between events). */
const SAME_PERIOD_MS = 60 * 60 * 1000;

async function ensureDiscountAttached(userId: string, subscriptionId: string | null, coupon: Coupon): Promise<void> {
  if (!subscriptionId || !coupon.stripeCouponId) return;
  if (coupon.durationCycles <= 1) return;
  if (!isStripeConfigured()) return;
  try {
    const attached = await getSubscriptionDiscountCouponId(subscriptionId);
    if (attached === coupon.stripeCouponId) return;
    await attachSubscriptionDiscount(subscriptionId, coupon.stripeCouponId);
    void recordPlanEvent({
      userId,
      type: "coupon_reattached",
      note: attached
        ? `The subscription was carrying a different discount; coupon ${coupon.code} has been re-applied`
        : `Coupon ${coupon.code} was missing from the subscription and has been re-applied`,
    });
  } catch {
    /* best-effort — never break a renewal over a discount repair */
  }
}

/** Counts a charged cycle against the coupon and retires it when spent. Idempotent per invoice / period end so webhook and reconcile can both call it. */
export async function consumeCycle(
  userId: string,
  subscriptionId: string | null,
  cyclePeriodEnd: Date | null,
  /** The Stripe invoice this charge produced, when the caller knows it. */
  invoiceId?: string | null,
): Promise<void> {
  try {
    const live = await getActiveRedemption(userId);
    if (!live) return;
    if (invoiceId) {
      if (live.lastCountedInvoiceId === invoiceId) return;
    } else if (
      cyclePeriodEnd &&
      live.lastCountedPeriodEnd &&
      Math.abs(cyclePeriodEnd.getTime() - live.lastCountedPeriodEnd.getTime()) < SAME_PERIOD_MS
    ) {
      return;
    }
    const db = await tenantForUser(userId);
    const counted = {
      lastCountedPeriodEnd: cyclePeriodEnd ?? live.lastCountedPeriodEnd,
      ...(invoiceId ? { lastCountedInvoiceId: invoiceId } : {}),
    };
    const cyclesUsed = live.cyclesUsed + 1;
    if (cyclesUsed < live.coupon.durationCycles) {
      await db.couponRedemption.update({ where: { id: live.id }, data: { cyclesUsed, ...counted } });
      await ensureDiscountAttached(userId, subscriptionId, live.coupon);
      return;
    }
    // Budget spent → retire it. The row STAYS as `exhausted`: it is what stops
    // this user redeeming the same code again.
    await db.$transaction([
      db.couponRedemption.update({
        where: { id: live.id },
        data: { cyclesUsed, status: "exhausted", endedAt: new Date(), ...counted },
      }),
      db.profile.update({ where: { userId }, data: { activeCouponRedemptionId: null } }),
    ]);
    if (subscriptionId && live.coupon.durationCycles > 1 && isStripeConfigured()) {
      await detachSubscriptionDiscount(subscriptionId).catch(() => {
        /* healed by healDiscountDrift on the next reconcile */
      });
    }
    await mirrorDiscountOntoSchedule(db, userId, null);
    void recordPlanEvent({
      userId,
      type: "coupon_expired",
      note: `Coupon ${live.coupon.code} finished — its ${live.coupon.durationCycles} billing cycle(s) are used up, so the next charge is full price`,
    });
  } catch {
    /* never let coupon bookkeeping break a renewal */
  }
}

/** Removes a live discount. `releaseSlot` deletes the row and gives the tally back so the code is reusable; otherwise it stays `revoked` and blocks re-entry. */
export async function revokeRedemption(
  userId: string,
  opts: { reason?: string; releaseSlot?: boolean } = {},
): Promise<boolean> {
  const live = await getActiveRedemption(userId);
  if (!live) return false;
  const db = await tenantForUser(userId);
  const profile = await db.profile.findUnique({ where: { userId }, select: { stripeSubscriptionId: true } });

  if (opts.releaseSlot) {
    await db.$transaction([
      db.couponRedemption.delete({ where: { id: live.id } }),
      db.profile.update({ where: { userId }, data: { activeCouponRedemptionId: null } }),
    ]);
    // Only a redemption that actually counted should be given back.
    await countRedeemed(live.couponId, -1).catch(() => {});
  } else {
    await db.$transaction([
      db.couponRedemption.update({ where: { id: live.id }, data: { status: "revoked", endedAt: new Date() } }),
      db.profile.update({ where: { userId }, data: { activeCouponRedemptionId: null } }),
    ]);
  }

  if (profile?.stripeSubscriptionId && isStripeConfigured()) {
    await detachSubscriptionDiscount(profile.stripeSubscriptionId).catch(() => {
      /* healed by healDiscountDrift on the next reconcile */
    });
  }
  await mirrorDiscountOntoSchedule(db, userId, null);
  void recordPlanEvent({
    userId,
    type: "coupon_expired",
    note: opts.reason ?? `Coupon ${live.coupon.code} removed`,
  });
  return true;
}

/* ------------------------------ Admin grants ------------------------------ */

export type GrantRejection =
  | "coupon_not_found"
  | "inactive"
  | "sold_out"
  | "already_used"
  | "no_subscription"
  | "expired"
  | "not_started"
  | "plan_not_eligible";

/** Admin-facing copy for why a grant can't go through. */
export const GRANT_REJECTION_MESSAGE: Record<GrantRejection, string> = {
  coupon_not_found: "That coupon no longer exists.",
  inactive: "That coupon is deactivated. Reactivate it on the Coupons page first, or pick an active one.",
  sold_out: "That coupon has hit its redemption limit. Raise the limit on the Coupons page, or pick another.",
  already_used: "This customer has already used that coupon — a code can only be redeemed once per account.",
  no_subscription:
    "This customer has no subscription yet, so there's nothing for a percentage discount to apply to. A bonus-minutes coupon would still work.",
  expired:
    "That coupon's redemption window has closed. Extend the date on the Coupons page, or confirm the override to grant it anyway.",
  not_started:
    "That coupon's redemption window hasn't opened yet. Change the start date on the Coupons page, or confirm the override to grant it early.",
  plan_not_eligible:
    "That coupon is limited to specific plans and this customer isn't on one of them. Change the plan restriction on the Coupons page, or confirm the override to grant it anyway.",
};

export type GrantRestriction = "expired" | "not_started" | "plan_not_eligible";

/** Wording shown next to the override confirmation. */
export const GRANT_RESTRICTION_WARNING: Record<GrantRestriction, string> = {
  expired: "This coupon has expired.",
  not_started: "This coupon's start date hasn't arrived yet.",
  plan_not_eligible: "This coupon is limited to other plans — this customer isn't on one of them.",
};

/** Which of those rules this grant would break, if any. */
export function grantRestrictions(
  coupon: { startsAt: Date | null; expiresAt: Date | null; planIds: string[] },
  profile: { subscriptionPlanId: string | null } | null,
  now = new Date(),
): GrantRestriction[] {
  const out: GrantRestriction[] = [];
  const window = redemptionWindow(coupon, now);
  if (window !== "open") out.push(window);
  if (coupon.planIds.length > 0 && (!profile?.subscriptionPlanId || !coupon.planIds.includes(profile.subscriptionPlanId))) {
    out.push("plan_not_eligible");
  }
  return out;
}

/** Admin grants a coupon directly, applied at once. Supersedes a pending reservation and any live discount. */
export async function grantCoupon(
  userId: string,
  couponId: string,
  adminUserId: string,
  opts: { override?: boolean } = {},
): Promise<{ ok: true } | { ok: false; reason: GrantRejection }> {
  const coupon = await prisma.coupon.findUnique({ where: { id: couponId } });
  if (!coupon) return { ok: false, reason: "coupon_not_found" };
  if (!coupon.active) return { ok: false, reason: "inactive" };

  const db = await tenantForUser(userId);
  const existing = await db.couponRedemption.findUnique({ where: { couponId_userId: { couponId, userId } } });
  // A reservation is fair game to overwrite — an admin grant supersedes an
  // unfinished checkout; anything further along means the code is spent.
  if (existing && existing.status !== "pending") return { ok: false, reason: "already_used" };
  if (coupon.maxRedemptions != null && coupon.redeemedCount >= coupon.maxRedemptions) {
    return { ok: false, reason: "sold_out" };
  }
  const profile = await db.profile.findUnique({
    where: { userId },
    select: { stripeSubscriptionId: true, subscriptionPlanId: true },
  });
  if (coupon.percentOff && !profile?.stripeSubscriptionId) {
    return { ok: false, reason: "no_subscription" };
  }
  const restrictions = grantRestrictions(coupon, profile);
  if (restrictions.length > 0 && !opts.override) {
    return { ok: false, reason: restrictions[0] };
  }

  await db.$transaction(async (inBrand) => {
    await lockUserCouponState(inBrand, userId);
    await inBrand.couponRedemption.updateMany({
      where: { userId, status: "active" },
      data: { status: "revoked", endedAt: new Date() },
    });
    if (existing) await inBrand.couponRedemption.delete({ where: { id: existing.id } });
    const created = await inBrand.couponRedemption.create({
      data: { couponId, userId, status: "active", appliedAt: new Date(), grantedBy: adminUserId },
    });
    await inBrand.profile.update({ where: { userId }, data: { activeCouponRedemptionId: created.id } });
  });
  await countRedeemed(couponId, 1);

  await syncStripeDiscountTo(db, userId, profile?.stripeSubscriptionId ?? null, coupon);
  void recordPlanEvent({
    userId,
    type: "coupon_applied",
    note: `${couponAppliedNote(coupon)} (granted by an admin)`,
  });
  return { ok: true };
}

/** One row in the admin's "grant a coupon" picker. */
export interface GrantableCoupon {
  id: string;
  code: string;
  displayName: string;
  percentOff: number | null;
  bonusMinutes: number | null;
  durationCycles: number;
  /** False → the picker disables it and shows `reason`. */
  eligible: boolean;
  reason: string | null;
  /** Grantable, but the admin should know something first. */
  warning: string | null;
  /** Breaks a rule an admin may step past — grantable only with an explicit
   *  override. */
  requiresOverride: boolean;
  restrictions: GrantRestriction[];
  /** The window date being stepped past (expiry, or a start that hasn't come). */
  windowEndsAt: string | null;
}

export async function grantableCoupons(userId: string): Promise<GrantableCoupon[]> {
  const db = await tenantForUser(userId);
  const [coupons, redemptions, profile] = await Promise.all([
    prisma.coupon.findMany({ where: { active: true }, orderBy: { createdAt: "desc" } }),
    db.couponRedemption.findMany({ where: { userId } }),
    db.profile.findUnique({ where: { userId }, select: { stripeSubscriptionId: true, subscriptionPlanId: true } }),
  ]);
  // Anything that isn't a bare reservation means this user is done with the code.
  const spentCouponIds = new Set(redemptions.filter((r) => r.status !== "pending").map((r) => r.couponId));
  // One clock for the whole list, so two coupons expiring in the same second
  // can't be judged against different "now"s.
  const now = new Date();
  return coupons.map((c) => {
    let reason: string | null = null;
    if (spentCouponIds.has(c.id)) reason = GRANT_REJECTION_MESSAGE.already_used;
    else if (c.maxRedemptions != null && c.redeemedCount >= c.maxRedemptions) reason = GRANT_REJECTION_MESSAGE.sold_out;
    else if (c.percentOff && !profile?.stripeSubscriptionId) reason = GRANT_REJECTION_MESSAGE.no_subscription;
    const restrictions = reason === null ? grantRestrictions(c, profile, now) : [];
    const warning = restrictions.map((r) => GRANT_RESTRICTION_WARNING[r]).join(" ") || null;
    return {
      id: c.id,
      code: c.code,
      displayName: c.displayName,
      percentOff: c.percentOff,
      bonusMinutes: c.bonusMinutes,
      durationCycles: c.durationCycles,
      eligible: reason === null,
      reason,
      warning,
      requiresOverride: restrictions.length > 0,
      restrictions,
      /** So the confirmation can name the date the admin is stepping past. */
      windowEndsAt: restrictions.includes("expired")
        ? (c.expiresAt?.toISOString() ?? null)
        : restrictions.includes("not_started")
          ? (c.startsAt?.toISOString() ?? null)
          : null,
    };
  });
}

/* ------------------------------ Entitlement ------------------------------ */

/** The plan's included minutes plus any bonus a live coupon adds. */
export async function effectiveIncludedMinutes(userId: string, planMinutes: number): Promise<number> {
  if (planMinutes <= 0) return planMinutes;
  const live = await getActiveRedemption(userId);
  const bonus = live?.coupon.bonusMinutes ?? 0;
  return planMinutes + (bonus > 0 ? bonus : 0);
}

/** Detaches a Stripe discount that ended on our side but is still attached (it'd keep undercharging). Only accounts that once held a coupon can drift, so it's an indexed lookup. */
export async function healDiscountDrift(userId: string, subscriptionId: string): Promise<void> {
  try {
    if (!isStripeConfigured()) return;
    const db = await tenantForUser(userId);
    const everEnded = await db.couponRedemption.findFirst({
      where: { userId, status: { in: ["exhausted", "revoked"] } },
      select: { id: true },
    });
    if (!everEnded) return;
    const live = await getActiveRedemption(userId);
    if (live) return; // a live discount is supposed to be attached
    const attached = await getSubscriptionDiscountCouponId(subscriptionId);
    if (!attached) return; // nothing attached — already consistent
    const ours = await prisma.coupon.findFirst({ where: { stripeCouponId: attached }, select: { id: true } });
    if (!ours) return;
    await detachSubscriptionDiscount(subscriptionId);
    await mirrorDiscountOntoSchedule(db, userId, null);
  } catch {
    /* fail open — reconcile must never break on discount tidy-up */
  }
}

export async function applyDiscountToSubscription(subscriptionId: string, coupon: Coupon): Promise<void> {
  if (!coupon.stripeCouponId || !isStripeConfigured()) return;
  await attachSubscriptionDiscount(subscriptionId, coupon.stripeCouponId);
}

/** Keep the Stripe coupon behind a catalogue row in step with its percentage. */
export async function syncStripeCoupon(coupon: {
  code: string;
  displayName: string;
  percentOff: number | null;
  durationCycles: number;
  stripeCouponId: string | null;
}): Promise<{ stripeCouponId: string | null }> {
  if (!coupon.percentOff) {
    if (coupon.stripeCouponId) await deleteStripeCoupon(coupon.stripeCouponId);
    return { stripeCouponId: null };
  }
  if (!isStripeConfigured()) return { stripeCouponId: coupon.stripeCouponId };
  if (coupon.stripeCouponId) return { stripeCouponId: coupon.stripeCouponId };
  const duration: StripeCouponDuration = coupon.durationCycles === 1 ? "once" : "forever";
  const stripeCouponId = await createStripeCoupon({
    name: `${coupon.displayName} (${coupon.code})`,
    percentOff: coupon.percentOff,
    duration,
  });
  return { stripeCouponId };
}

/** Frees abandoned-checkout reservations across every tenant. Rows are DELETED, not marked — a leftover would trip the unique index and lock the user out of a code they never used. */
export async function sweepStalePendingRedemptions(): Promise<number> {
  const cutoff = new Date(Date.now() - PENDING_RESERVATION_TTL_MS);
  let total = 0;
  for (const { db } of await allTenants()) {
    const { count } = await db.couponRedemption.deleteMany({
      where: { status: "pending", reservedAt: { lte: cutoff } },
    });
    total += count;
  }
  return total;
}
