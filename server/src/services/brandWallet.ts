import { Prisma } from "@prisma/client";
import { prisma } from "../prisma.js";
import { emailsFor } from "./customerDirectory.js";
import { badRequest, notFound } from "../lib/http.js";
import { audit } from "./audit.js";

/* ------------------------------------------------------------------ *
 *  Brand wallet — the ledger of what the platform owes a brand.
 *
 *  A customer of Acme pays the platform base + Acme's addon. On every
 *  paid invoice, Acme's share is CREDITED here — from the platform
 *  ledger's row for that payment, which is where the split is decided
 *  (services/platformLedger.ts). The platform owner pays
 *  Acme by hand (bank transfer today, Stripe Connect later) and records a
 *  PAYOUT, which is a negative entry. The balance is never stored — it is
 *  the sum of the ledger, per currency, so it can't drift.
 * ------------------------------------------------------------------ */

export type WalletEntryType = "credit" | "payout" | "reversal";

export interface WalletBalance {
  currency: string;
  balanceCents: number;
  creditedCents: number;
  paidOutCents: number;
}

/**
 * Credit a brand's wallet from a platform-ledger row.
 *
 * The split was decided when the payment was written to the ledger
 * (services/platformLedger.ts): the brand's share is `brandCents`, already
 * proportional to what was actually paid. This only books it — once. The
 * unique invoice id turns every later attempt into a no-op, so whichever
 * path recorded the payment first credits the wallet and the rest find it
 * done. A row with no brand share (a subscription on the platform's own
 * Price) credits nothing.
 */
export async function creditWalletFromLedger(row: {
  brandId: string;
  userId: string;
  stripeInvoiceId: string;
  brandCents: number;
  currency: string;
  planId: string | null;
}): Promise<number> {
  if (row.brandCents <= 0) return 0;
  try {
    // Every invoice-paid path offers the credit; all but the first find it
    // booked. A read first keeps that common case quiet (no logged unique-
    // constraint error); the constraint still settles a genuine race below.
    const booked = await prisma.brandWalletEntry.findUnique({
      where: { stripeInvoiceId: row.stripeInvoiceId },
      select: { id: true },
    });
    if (booked) return 0;
    const plan = row.planId
      ? await prisma.subscriptionPlan.findUnique({ where: { id: row.planId }, select: { displayName: true } })
      : null;
    await prisma.brandWalletEntry.create({
      data: {
        brandId: row.brandId,
        type: "credit",
        amountCents: row.brandCents,
        currency: row.currency,
        stripeInvoiceId: row.stripeInvoiceId,
        customerId: row.userId,
        planId: row.planId,
        note: `${plan?.displayName ?? "Plan"} · addon share of a paid invoice`,
      },
    });
    return row.brandCents;
  } catch (e) {
    // P2002 = the invoice was already credited by another path. Anything else
    // is logged and swallowed: a missed credit is visible against the ledger
    // and can be reconciled; a failed webhook would be retried forever.
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") return 0;
    console.warn("Brand wallet credit failed:", e instanceof Error ? e.message : e);
    return 0;
  }
}

/** Balances per currency for one brand, straight from the ledger. */
export async function walletBalances(brandId: string): Promise<WalletBalance[]> {
  const rows = await prisma.brandWalletEntry.groupBy({
    by: ["currency", "type"],
    where: { brandId },
    _sum: { amountCents: true },
  });
  const byCurrency = new Map<string, WalletBalance>();
  for (const r of rows) {
    const b = byCurrency.get(r.currency) ?? {
      currency: r.currency,
      balanceCents: 0,
      creditedCents: 0,
      paidOutCents: 0,
    };
    const sum = r._sum.amountCents ?? 0;
    b.balanceCents += sum;
    if (r.type === "credit") b.creditedCents += sum;
    if (r.type === "payout") b.paidOutCents += -sum;
    byCurrency.set(r.currency, b);
  }
  return [...byCurrency.values()].sort((a, b) => a.currency.localeCompare(b.currency));
}

/** Balances for many brands at once — the super admin's brand list. */
export async function walletBalancesFor(
  brandIds: string[],
): Promise<Map<string, { currency: string; balanceCents: number }[]>> {
  const out = new Map<string, { currency: string; balanceCents: number }[]>();
  if (!brandIds.length) return out;
  const rows = await prisma.brandWalletEntry.groupBy({
    by: ["brandId", "currency"],
    where: { brandId: { in: brandIds } },
    _sum: { amountCents: true },
  });
  for (const r of rows) {
    const list = out.get(r.brandId) ?? [];
    list.push({ currency: r.currency, balanceCents: r._sum.amountCents ?? 0 });
    out.set(r.brandId, list);
  }
  return out;
}

export interface WalletEntryView {
  id: string;
  type: WalletEntryType;
  amountCents: number;
  currency: string;
  stripeInvoiceId: string | null;
  /** On a reversal: the invoice whose credit it undid. */
  relatedInvoiceId: string | null;
  customerId: string | null;
  customerEmail: string | null;
  planId: string | null;
  planName: string | null;
  note: string;
  reference: string;
  createdAt: string;
}

/** The most recent ledger entries, newest first, with the names an operator
 *  reads them by rather than the ids they're stored by. */
export async function listWalletEntries(brandId: string, limit = 200): Promise<WalletEntryView[]> {
  const entries = await prisma.brandWalletEntry.findMany({
    where: { brandId },
    orderBy: { createdAt: "desc" },
    take: Math.min(Math.max(limit, 1), 500),
  });
  const customerIds = [...new Set(entries.map((e) => e.customerId).filter((v): v is string => !!v))];
  const planIds = [...new Set(entries.map((e) => e.planId).filter((v): v is string => !!v))];
  const [customers, plans] = await Promise.all([
    emailsFor(customerIds),
    planIds.length
      ? prisma.subscriptionPlan.findMany({ where: { id: { in: planIds } }, select: { id: true, displayName: true } })
      : [],
  ]);
  const emailById = customers;
  const planById = new Map(plans.map((p) => [p.id, p.displayName]));
  return entries.map((e) => ({
    id: e.id,
    type: e.type as WalletEntryType,
    amountCents: e.amountCents,
    currency: e.currency,
    stripeInvoiceId: e.stripeInvoiceId,
    relatedInvoiceId: e.relatedInvoiceId,
    customerId: e.customerId,
    customerEmail: e.customerId ? (emailById.get(e.customerId) ?? null) : null,
    planId: e.planId,
    planName: e.planId ? (planById.get(e.planId) ?? null) : null,
    note: e.note,
    reference: e.reference,
    createdAt: e.createdAt.toISOString(),
  }));
}

/**
 * Record that the platform paid the brand. The money moved outside the app —
 * a bank transfer, a Stripe transfer done by hand — so this is bookkeeping:
 * a negative entry that lowers the balance, with the reference the brand can
 * match against its own statement. Never more than the balance in that
 * currency; a wallet does not go negative.
 */
export async function recordPayout(opts: {
  brandId: string;
  amountCents: number;
  currency: string;
  reference?: string;
  note?: string;
  actor: { id: string; email: string; ip?: string };
}): Promise<WalletEntryView> {
  const amount = Number(opts.amountCents);
  if (!Number.isInteger(amount) || amount <= 0) throw badRequest("Enter a payout amount in cents.");
  const currency = (opts.currency ?? "").trim().toLowerCase();
  if (!/^[a-z]{3}$/.test(currency)) throw badRequest("Pick the currency being paid out.");

  const brand = await prisma.brand.findUnique({ where: { id: opts.brandId } });
  if (!brand) throw notFound("Brand not found");

  const balance = (await walletBalances(opts.brandId)).find((b) => b.currency === currency);
  const available = balance?.balanceCents ?? 0;
  if (amount > available) {
    throw badRequest(
      `That's more than the wallet holds — ${available} ${currency.toUpperCase()} cents are available.`,
    );
  }

  const entry = await prisma.brandWalletEntry.create({
    data: {
      brandId: opts.brandId,
      type: "payout",
      amountCents: -amount,
      currency,
      reference: (opts.reference ?? "").trim().slice(0, 120),
      note: (opts.note ?? "").trim().slice(0, 500),
      createdById: opts.actor.id,
    },
  });

  void audit({
    actorId: opts.actor.id,
    actorEmail: opts.actor.email,
    action: "brand.wallet.payout",
    targetType: "brand",
    targetId: opts.brandId,
    metadata: { amountCents: amount, currency, reference: entry.reference },
    ip: opts.actor.ip,
  });

  return {
    id: entry.id,
    type: "payout",
    amountCents: entry.amountCents,
    currency: entry.currency,
    stripeInvoiceId: null,
    relatedInvoiceId: null,
    customerId: null,
    customerEmail: null,
    planId: null,
    planName: null,
    note: entry.note,
    reference: entry.reference,
    createdAt: entry.createdAt.toISOString(),
  };
}

/**
 * Undo (part of) a credit when the customer's charge is refunded.
 *
 * Works from Stripe's CUMULATIVE `amount_refunded` on the charge, not from
 * individual refund objects (which the charge payload no longer carries by
 * default): the reversal that should exist in total is the credit scaled by
 * the refunded fraction, and only the difference from what is already booked
 * is written. A replayed or repeated webhook therefore books nothing new, and
 * two partial refunds produce two correctly sized reversals.
 */
export async function reverseCreditForRefund(opts: {
  invoiceId: string;
  chargeId: string;
  /** The charge's full amount and how much of it is now refunded, in cents. */
  chargeAmountCents: number;
  amountRefundedCents: number;
}): Promise<{ reversed: number }> {
  try {
    if (!opts.invoiceId || opts.chargeAmountCents <= 0 || opts.amountRefundedCents <= 0) {
      return { reversed: 0 };
    }
    const credit = await prisma.brandWalletEntry.findUnique({
      where: { stripeInvoiceId: opts.invoiceId },
    });
    if (!credit || credit.type !== "credit" || credit.amountCents <= 0) return { reversed: 0 };

    const fraction = Math.min(1, opts.amountRefundedCents / opts.chargeAmountCents);
    const shouldBeReversed = Math.min(credit.amountCents, Math.round(credit.amountCents * fraction));

    const prior = await prisma.brandWalletEntry.findMany({
      where: { relatedInvoiceId: opts.invoiceId, type: "reversal" },
      select: { amountCents: true },
    });
    const alreadyReversed = prior.reduce((sum, e) => sum + Math.abs(e.amountCents), 0);
    const delta = shouldBeReversed - alreadyReversed;
    if (delta <= 0) return { reversed: 0 };

    await prisma.brandWalletEntry.create({
      data: {
        brandId: credit.brandId,
        type: "reversal",
        amountCents: -delta,
        currency: credit.currency,
        relatedInvoiceId: opts.invoiceId,
        customerId: credit.customerId,
        planId: credit.planId,
        reference: opts.chargeId,
        note: `Refund on invoice ${opts.invoiceId}`,
      },
    });
    return { reversed: delta };
  } catch (e) {
    console.warn("Brand wallet reversal failed:", e instanceof Error ? e.message : e);
    return { reversed: 0 };
  }
}
