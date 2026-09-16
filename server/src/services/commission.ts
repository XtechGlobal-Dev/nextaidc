import { resolveStripeCustomer } from "./stripeCustomers.js";
import { tenantFor } from "./tenantDb.js";

/** Accrues a reseller's referral commission for a paid invoice. Idempotent on invoice id (webhook and reconcile both call it); never throws. Everything lives in the customer's brand DB. */
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
