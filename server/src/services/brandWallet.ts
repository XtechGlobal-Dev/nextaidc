import { Prisma } from "@prisma/client";
import { prisma } from "../prisma.js";
import { emailsFor } from "./customerDirectory.js";
import { badRequest, notFound } from "../lib/http.js";
import { audit } from "./audit.js";

// Brand wallet: what the platform owes a brand. Credits come from the platform ledger row (where the
// split is decided); payouts are negative entries recorded by hand. Balance is never stored — always summed, so it can't drift.

export type WalletEntryType = "credit" | "payout" | "reversal";

export interface WalletBalance {
  currency: string;
  balanceCents: number;
  creditedCents: number;
  paidOutCents: number;
}

/** Books a ledger row's brand share exactly once — the unique invoice id makes every later attempt a no-op. A row with no brand share credits nothing. */
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
    // Read first so the common "already booked" case doesn't log a unique-constraint error;
    // the constraint still settles a genuine race below.
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
    // P2002 = already credited elsewhere. Anything else is swallowed: a missed credit is
    // reconcilable against the ledger, but a failed webhook would retry forever.
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

/** Bookkeeping for a payout made outside the app: a negative entry with a reference. Never more than the balance in that currency — a wallet does not go negative. */
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

/** Reverses (part of) a credit on refund. Works from Stripe's CUMULATIVE amount_refunded and books only the delta from what's already reversed, so replayed webhooks and partial refunds both come out right. */
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
