import { resolveStripeCustomer } from "./stripeCustomers.js";
import { tenantFor } from "./tenantDb.js";

/**
 * Accrue a reseller's referral commission for a paid Stripe invoice — if the
 * paying customer was referred by a reseller. Idempotent on the invoice id, so
 * the Stripe webhook AND the local reconcile path can both call it without
 * double-counting. Best-effort; never throws.
 *
 * The paying customer is found through the Stripe customer index, the same
 * way every payment is placed; the reseller, the customer and the commission
 * row all live in that customer's brand's database (phase 6).
 */
export async function accrueCommissionForInvoice(opts: {
  invoiceId: string;
  customerId: string;
  amountPaidCents: number;
}): Promise<void> {
  try {
    if (!opts.invoiceId || !opts.customerId || opts.amountPaidCents <= 0) return;

    const owner = await resolveStripeCustomer(opts.customerId);
    if (!owner) return;
    const db = await tenantFor(owner.brandId);

    const already = await db.commission.findFirst({ where: { stripeInvoiceId: opts.invoiceId } });
    if (already) return;

    const customer = await db.user.findUnique({
      where: { id: owner.userId },
      select: { referredById: true },
    });
    const referredById = customer?.referredById;
    if (!referredById) return;

    const reseller = await db.user.findUnique({
      where: { id: referredById },
      select: { commissionPercent: true },
    });
    const percent = reseller?.commissionPercent ?? 0;
    const amountCents = Math.round(opts.amountPaidCents * (percent / 100));
    if (amountCents <= 0) return;

    await db.commission.create({
      data: {
        resellerId: referredById,
        customerId: owner.userId,
        amountCents,
        percent,
        invoiceAmountCents: opts.amountPaidCents,
        stripeInvoiceId: opts.invoiceId,
        status: "pending",
      },
    });
  } catch {
    /* best-effort — a missed accrual is reconciled by the webhook / next call */
  }
}
