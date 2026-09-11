import express from "express";
import { requestTenant, tenantForUser } from "../services/tenantDb.js";
import { asyncHandler, notFound } from "../lib/http.js";
import { requireAuth, requireReseller } from "../middleware/auth.js";
import { isStripeConfigured, getLatestPaidInvoice } from "../services/stripe.js";
import { accrueCommissionForInvoice } from "../services/commission.js";

/** Best-effort: backfill commission for active referred customers whose paid
 *  invoice we missed (e.g. activated via local reconcile, no webhook). Idempotent. */
async function backfillReferralCommissions(resellerId: string): Promise<void> {
  if (!isStripeConfigured()) return;
  try {
    const active = await (await tenantForUser(resellerId)).user.findMany({
      where: { referredById: resellerId, profile: { subscriptionStatus: "active" } },
      select: { profile: { select: { stripeSubscriptionId: true } } },
    });
    await Promise.all(
      active.map(async (u) => {
        const subId = u.profile?.stripeSubscriptionId;
        if (!subId) return;
        try {
          const inv = await getLatestPaidInvoice(subId);
          if (inv)
            await accrueCommissionForInvoice({
              invoiceId: inv.id,
              customerId: inv.customerId,
              amountPaidCents: inv.amountPaidCents,
            });
        } catch {
          /* skip this customer */
        }
      }),
    );
  } catch {
    /* best-effort — never block the overview */
  }
}

const router = express.Router();

router.use(requireAuth, requireReseller);

/**
 * Reseller dashboard: their referral code + commission rate, the customers
 * they've referred (no contact PII), and commission totals.
 */
router.get(
  "/overview",
  asyncHandler(async (req, res) => {
    const resellerId = req.user!.sub;

    // Catch up any commission missed by the webhook before reading the totals.
    await backfillReferralCommissions(resellerId);

    const [me, referred, commissions] = await Promise.all([
      (await requestTenant(req)).user.findUnique({
        where: { id: resellerId },
        select: { referralCode: true, commissionPercent: true },
      }),
      (await requestTenant(req)).user.findMany({
        where: { referredById: resellerId },
        select: {
          id: true,
          fullName: true,
          createdAt: true,
          profile: { select: { businessName: true, plan: true, subscriptionStatus: true } },
        },
        orderBy: { createdAt: "desc" },
      }),
      (await requestTenant(req)).commission.findMany({
        where: { resellerId },
        select: { amountCents: true, status: true, customerId: true },
      }),
    ]);

    const earnedCents = commissions
      .filter((c) => c.status === "paid")
      .reduce((sum, c) => sum + c.amountCents, 0);
    const pendingCents = commissions
      .filter((c) => c.status !== "paid")
      .reduce((sum, c) => sum + c.amountCents, 0);

    // Commission accrued per referred customer (all statuses).
    const byCustomer = new Map<string, number>();
    for (const c of commissions) {
      byCustomer.set(c.customerId, (byCustomer.get(c.customerId) ?? 0) + c.amountCents);
    }

    res.json({
      referralCode: me?.referralCode ?? null,
      commissionPercent: me?.commissionPercent ?? 0,
      referredCount: referred.length,
      earnedCents,
      pendingCents,
      // Limited view — business name + status only, no contact details.
      customers: referred.map((c) => ({
        id: c.id,
        name: c.profile?.businessName || c.fullName,
        plan: c.profile?.plan ?? "free",
        subscriptionStatus: c.profile?.subscriptionStatus ?? "none",
        joinedAt: c.createdAt,
        commissionCents: byCustomer.get(c.id) ?? 0,
      })),
    });
  }),
);

/**
 * Full detail for a single referred customer. Scoped strictly to the reseller's
 * OWN referrals (`referredById === resellerId`) — a reseller can never read a
 * customer they didn't refer. Returns contact + subscription + this reseller's
 * commission history for the customer. Deliberately excludes operational data
 * (call logs/recordings, AI config) and payment internals (Stripe IDs).
 */
router.get(
  "/customers/:id",
  asyncHandler(async (req, res) => {
    const resellerId = req.user!.sub;
    const customerId = req.params.id;

    // findFirst with the ownership filter baked in — never trust the id alone.
    const customer = await (await requestTenant(req)).user.findFirst({
      where: { id: customerId, referredById: resellerId },
      select: {
        id: true,
        email: true,
        fullName: true,
        createdAt: true,
        profile: {
          select: {
            businessName: true,
            mobile: true,
            website: true,
            businessNumber: true,
            plan: true,
            subscriptionStatus: true,
            trialEndsAt: true,
            currentPeriodEnd: true,
            autoRenew: true,
          },
        },
      },
    });
    if (!customer) throw notFound("Customer not found");

    const commissions = await (await requestTenant(req)).commission.findMany({
      where: { resellerId, customerId },
      select: {
        amountCents: true,
        percent: true,
        invoiceAmountCents: true,
        status: true,
        createdAt: true,
      },
      orderBy: { createdAt: "desc" },
    });

    const totalCents = commissions.reduce((sum, c) => sum + c.amountCents, 0);
    const paidCents = commissions
      .filter((c) => c.status === "paid")
      .reduce((sum, c) => sum + c.amountCents, 0);

    res.json({
      id: customer.id,
      name: customer.profile?.businessName || customer.fullName,
      fullName: customer.fullName,
      email: customer.email,
      businessName: customer.profile?.businessName ?? "",
      mobile: customer.profile?.mobile ?? "",
      website: customer.profile?.website ?? "",
      businessNumber: customer.profile?.businessNumber ?? "",
      plan: customer.profile?.plan ?? "free",
      subscriptionStatus: customer.profile?.subscriptionStatus ?? "none",
      joinedAt: customer.createdAt,
      trialEndsAt: customer.profile?.trialEndsAt ?? null,
      currentPeriodEnd: customer.profile?.currentPeriodEnd ?? null,
      autoRenew: customer.profile?.autoRenew ?? true,
      commission: { totalCents, paidCents, pendingCents: totalCents - paidCents },
      commissionHistory: commissions,
    });
  }),
);

export default router;
