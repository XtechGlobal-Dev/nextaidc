import { Prisma, type PlatformLedger } from "@prisma/client";
import { prisma } from "../prisma.js";
import { emailsFor } from "./customerDirectory.js";
import { tenantFor, tenantForUser } from "./tenantDb.js";
import { resolveStripeCustomer, type StripeOwner } from "./stripeCustomers.js";
import { creditWalletFromLedger } from "./brandWallet.js";

// Platform ledger: one payment, one row, split platform/brand. Everything money-shaped
// reads from here so numbers can't disagree. Idempotent on invoice id across all paid paths.

export type LedgerSource = "webhook" | "reconcile" | "renewal" | "go_live";

export interface PaidInvoice {
  invoiceId: string;
  /** Stripe customer id on the invoice. */
  customerId: string;
  amountPaidCents: number;
  /** The Stripe Price the invoice billed, when the caller has it. With it the
   *  split is exact; without it the customer's current plan stands in. */
  priceId?: string | null;
  currency?: string | null;
  periodStart?: Date | null;
  periodEnd?: Date | null;
  /** Stripe coupon id on the invoice's discount, when the caller has it. */
  stripeCouponId?: string | null;
  source?: LedgerSource;
}

export interface LedgerOutcome {
  ledger: PlatformLedger | null;
  /** Cents credited to the brand's wallet by THIS call (0 when already booked). */
  credited: number;
  /** The invoice was already in the ledger; nothing new was written. */
  alreadyBooked: boolean;
  /** No brand holds the Stripe customer — the caller parks the event. */
  unrouted: boolean;
}

const NOTHING: LedgerOutcome = { ledger: null, credited: 0, alreadyBooked: false, unrouted: false };

/** Books a paid invoice and credits the brand wallet from it. Idempotent on invoice id; never throws — a missed row is reconcilable, a failed webhook retries forever. */
export async function recordPaidInvoice(inv: PaidInvoice): Promise<LedgerOutcome> {
  try {
    if (!inv.invoiceId || !inv.customerId || inv.amountPaidCents <= 0) return NOTHING;

    const existing = await prisma.platformLedger.findUnique({ where: { stripeInvoiceId: inv.invoiceId } });
    if (existing) {
      return { ledger: existing, credited: await creditWalletFromLedger(existing), alreadyBooked: true, unrouted: false };
    }

    const owner = await resolveStripeCustomer(inv.customerId);
    if (!owner) return { ...NOTHING, unrouted: true };

    const split = await splitFor(owner, inv);
    const ledger = await prisma.platformLedger.create({
      data: {
        stripeInvoiceId: inv.invoiceId,
        stripeCustomerId: inv.customerId,
        brandId: owner.brandId,
        userId: owner.userId,
        planId: split.planId,
        couponId: await couponFor(owner.userId, inv.stripeCouponId),
        currency: split.currency,
        totalCents: inv.amountPaidCents,
        platformCents: inv.amountPaidCents - split.brandCents,
        brandCents: split.brandCents,
        periodStart: inv.periodStart ?? null,
        periodEnd: inv.periodEnd ?? null,
        source: inv.source ?? "webhook",
      },
    });
    return { ledger, credited: await creditWalletFromLedger(ledger), alreadyBooked: false, unrouted: false };
  } catch (e) {
    // P2002: another path booked this invoice between our lookup and our
    // write. Its row is the row.
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
      const row = await prisma.platformLedger.findUnique({ where: { stripeInvoiceId: inv.invoiceId } });
      return row
        ? { ledger: row, credited: await creditWalletFromLedger(row), alreadyBooked: true, unrouted: false }
        : NOTHING;
    }
    console.warn("[ledger] could not record paid invoice:", e instanceof Error ? e.message : e);
    return NOTHING;
  }
}

// Brand share is proportional to what was paid, not a flat addon (a 50% coupon
// halves it). A subscription on the platform's own Price gives the brand nothing.
async function splitFor(
  owner: StripeOwner,
  inv: PaidInvoice,
): Promise<{ brandCents: number; planId: string | null; currency: string }> {
  const profile = await (await tenantFor(owner.brandId)).profile.findUnique({
    where: { userId: owner.userId },
    select: { subscriptionPlanId: true },
  });
  const addon = inv.priceId
    ? await prisma.brandPlanAddon.findFirst({
        where: { brandId: owner.brandId, stripePriceId: inv.priceId },
        include: { plan: { select: { priceCents: true, currency: true } } },
      })
    : profile?.subscriptionPlanId
      ? await prisma.brandPlanAddon.findUnique({
          where: { brandId_planId: { brandId: owner.brandId, planId: profile.subscriptionPlanId } },
          include: { plan: { select: { priceCents: true, currency: true } } },
        })
      : null;

  const planId = addon?.planId ?? profile?.subscriptionPlanId ?? null;
  const plan =
    addon?.plan ??
    (planId
      ? await prisma.subscriptionPlan.findUnique({ where: { id: planId }, select: { priceCents: true, currency: true } })
      : null);
  const currency = (inv.currency ?? plan?.currency ?? "usd").toLowerCase();

  if (!addon || addon.addonCents <= 0) return { brandCents: 0, planId, currency };
  const brandPrice = addon.plan.priceCents + addon.addonCents;
  if (brandPrice <= 0) return { brandCents: 0, planId, currency };
  const brandCents = Math.min(inv.amountPaidCents, Math.round((inv.amountPaidCents * addon.addonCents) / brandPrice));
  return { brandCents: Math.max(0, brandCents), planId, currency };
}

/** The coupon on this payment, by our id: the Stripe coupon on the invoice
 *  when known, else the discount the account is currently holding. */
async function couponFor(userId: string, stripeCouponId: string | null | undefined): Promise<string | null> {
  if (stripeCouponId) {
    const byStripe = await prisma.coupon.findFirst({ where: { stripeCouponId }, select: { id: true } });
    if (byStripe) return byStripe.id;
  }
  const db = await tenantForUser(userId);
  const profile = await db.profile.findUnique({
    where: { userId },
    select: { activeCouponRedemptionId: true },
  });
  if (!profile?.activeCouponRedemptionId) return null;
  const redemption = await db.couponRedemption.findUnique({
    where: { id: profile.activeCouponRedemptionId },
    select: { couponId: true },
  });
  return redemption?.couponId ?? null;
}

/** Notes a refund, cumulative from Stripe's amount_refunded so replays are no-ops. The row stays; the wallet reversal is booked separately. */
export async function recordRefund(opts: {
  invoiceId: string;
  chargeAmountCents: number;
  amountRefundedCents: number;
}): Promise<void> {
  try {
    if (!opts.invoiceId || opts.chargeAmountCents <= 0) return;
    const row = await prisma.platformLedger.findUnique({ where: { stripeInvoiceId: opts.invoiceId } });
    if (!row) return;
    const fraction = Math.min(1, Math.max(0, opts.amountRefundedCents / opts.chargeAmountCents));
    const refundedCents = Math.round(row.totalCents * fraction);
    if (refundedCents === row.refundedCents) return;
    await prisma.platformLedger.update({ where: { id: row.id }, data: { refundedCents } });
  } catch (e) {
    console.warn("[ledger] could not record refund:", e instanceof Error ? e.message : e);
  }
}

export interface LedgerTotals {
  currency: string;
  payments: number;
  totalCents: number;
  platformCents: number;
  brandCents: number;
  refundedCents: number;
}

export interface LedgerBrandTotals extends LedgerTotals {
  brandId: string;
}

/** What was earned in a window — overall and per brand, per currency. The
 *  super admin's "this month" numbers; one grouped query, however many brands. */
export async function ledgerSummary(opts: {
  from: Date;
  to: Date;
  brandId?: string | null;
}): Promise<{ totals: LedgerTotals[]; byBrand: LedgerBrandTotals[] }> {
  const where: Prisma.PlatformLedgerWhereInput = {
    paidAt: { gte: opts.from, lt: opts.to },
    ...(opts.brandId ? { brandId: opts.brandId } : {}),
  };
  const rows = await prisma.platformLedger.groupBy({
    by: ["brandId", "currency"],
    where,
    _count: { _all: true },
    _sum: { totalCents: true, platformCents: true, brandCents: true, refundedCents: true },
  });
  const byBrand: LedgerBrandTotals[] = rows.map((r) => ({
    brandId: r.brandId,
    currency: r.currency,
    payments: r._count._all,
    totalCents: r._sum.totalCents ?? 0,
    platformCents: r._sum.platformCents ?? 0,
    brandCents: r._sum.brandCents ?? 0,
    refundedCents: r._sum.refundedCents ?? 0,
  }));
  const totals = new Map<string, LedgerTotals>();
  for (const b of byBrand) {
    const t = totals.get(b.currency) ?? {
      currency: b.currency,
      payments: 0,
      totalCents: 0,
      platformCents: 0,
      brandCents: 0,
      refundedCents: 0,
    };
    t.payments += b.payments;
    t.totalCents += b.totalCents;
    t.platformCents += b.platformCents;
    t.brandCents += b.brandCents;
    t.refundedCents += b.refundedCents;
    totals.set(b.currency, t);
  }
  return {
    totals: [...totals.values()].sort((a, b) => a.currency.localeCompare(b.currency)),
    byBrand: byBrand.sort((a, b) => b.totalCents - a.totalCents),
  };
}

export interface LedgerRowView {
  id: string;
  stripeInvoiceId: string;
  userId: string;
  customerEmail: string | null;
  planId: string | null;
  planName: string | null;
  couponId: string | null;
  currency: string;
  totalCents: number;
  platformCents: number;
  brandCents: number;
  refundedCents: number;
  periodStart: string | null;
  periodEnd: string | null;
  source: string;
  paidAt: string;
}

/** One brand's most recent payments, newest first, with the names an operator
 *  reads them by. */
export async function listLedgerRows(brandId: string, limit = 100): Promise<LedgerRowView[]> {
  const rows = await prisma.platformLedger.findMany({
    where: { brandId },
    orderBy: { paidAt: "desc" },
    take: Math.min(Math.max(limit, 1), 500),
  });
  const userIds = [...new Set(rows.map((r) => r.userId))];
  const planIds = [...new Set(rows.map((r) => r.planId).filter((v): v is string => !!v))];
  const [users, plans] = await Promise.all([
    emailsFor(userIds),
    planIds.length
      ? prisma.subscriptionPlan.findMany({ where: { id: { in: planIds } }, select: { id: true, displayName: true } })
      : [],
  ]);
  const emailById = users;
  const planById = new Map(plans.map((p) => [p.id, p.displayName]));
  return rows.map((r) => ({
    id: r.id,
    stripeInvoiceId: r.stripeInvoiceId,
    userId: r.userId,
    customerEmail: emailById.get(r.userId) ?? null,
    planId: r.planId,
    planName: r.planId ? (planById.get(r.planId) ?? null) : null,
    couponId: r.couponId,
    currency: r.currency,
    totalCents: r.totalCents,
    platformCents: r.platformCents,
    brandCents: r.brandCents,
    refundedCents: r.refundedCents,
    periodStart: r.periodStart?.toISOString() ?? null,
    periodEnd: r.periodEnd?.toISOString() ?? null,
    source: r.source,
    paidAt: r.paidAt.toISOString(),
  }));
}
