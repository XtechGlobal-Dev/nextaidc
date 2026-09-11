import { describe, it, expect, vi, beforeEach } from "vitest";
import { Prisma } from "@prisma/client";

/* ------------------------------------------------------------------ *
 *  The platform ledger: one paid invoice → one row, split into the
 *  platform's share and the brand's, with the wallet credited FROM that
 *  row. The plan's own worked example is the first test: a $50 plan with
 *  a $25 brand addon, paid in full, is $50 to the platform and $25 to
 *  the brand.
 * ------------------------------------------------------------------ */

const h = vi.hoisted(() => ({
  ledgerFindUnique: vi.fn(),
  ledgerCreate: vi.fn(),
  ledgerUpdate: vi.fn(),
  ledgerGroupBy: vi.fn(),
  profileFindUnique: vi.fn(),
  addonFindFirst: vi.fn(),
  addonFindUnique: vi.fn(),
  planFindUnique: vi.fn(),
  couponFindFirst: vi.fn(),
  redemptionFindUnique: vi.fn(),
  resolve: vi.fn(),
  credit: vi.fn(),
}));

vi.mock("../prisma.js", () => ({
  prisma: {
    platformLedger: {
      findUnique: h.ledgerFindUnique,
      create: h.ledgerCreate,
      update: h.ledgerUpdate,
      groupBy: h.ledgerGroupBy,
      findMany: vi.fn(async () => []),
    },
    profile: { findUnique: h.profileFindUnique },
    brandPlanAddon: { findFirst: h.addonFindFirst, findUnique: h.addonFindUnique },
    subscriptionPlan: { findUnique: h.planFindUnique, findMany: vi.fn(async () => []) },
    coupon: { findFirst: h.couponFindFirst },
    couponRedemption: { findUnique: h.redemptionFindUnique },
    user: { findMany: vi.fn(async () => []) },
  },
}));
vi.mock("./tenantDb.js", async () =>
  (await import("../test/tenantDbFake.js")).tenantDbFake({}),
);
// Customer emails come from the thin directory; here, from the same stand-in's users.
vi.mock("./customerDirectory.js", async () => {
  const { prisma } = await import("../prisma.js");
  const users = prisma as unknown as { user: { findMany: (a: unknown) => Promise<{ id: string; email: string }[]> } };
  return {
    brandIdForOwner: async () => "b_acme",
    emailsFor: async (ids: string[]) =>
      new Map((await users.user.findMany({ where: { id: { in: ids } }, select: { id: true, email: true } })).map((u) => [u.id, u.email])),
  };
});
vi.mock("./stripeCustomers.js", () => ({ resolveStripeCustomer: h.resolve }));
vi.mock("./brandWallet.js", () => ({ creditWalletFromLedger: h.credit }));

const { recordPaidInvoice, recordRefund, ledgerSummary } = await import("./platformLedger.js");

/** bostan&co sells the $50 "Professional" plan for $75. */
const acmeOwner = { brandId: "b_acme", userId: "u_cust" };
const proAddon = {
  id: "a1",
  brandId: "b_acme",
  planId: "p_pro",
  addonCents: 2500,
  stripePriceId: "price_acme_pro",
  plan: { priceCents: 5000, currency: "usd" },
};

beforeEach(() => {
  vi.clearAllMocks();
  h.ledgerFindUnique.mockResolvedValue(null);
  h.ledgerCreate.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
    id: "l1",
    refundedCents: 0,
    createdAt: new Date(),
    paidAt: new Date(),
    ...data,
  }));
  h.credit.mockImplementation(async (row: { brandCents: number }) => row.brandCents);
  h.profileFindUnique.mockResolvedValue({ subscriptionPlanId: "p_pro", activeCouponRedemptionId: null });
  h.resolve.mockResolvedValue(acmeOwner);
});

describe("recordPaidInvoice — the $75 example", () => {
  it("books $50 to the platform and $25 to the brand, and credits the wallet from the row", async () => {
    h.addonFindFirst.mockResolvedValue(proAddon);

    const out = await recordPaidInvoice({
      invoiceId: "in_1",
      customerId: "cus_1",
      amountPaidCents: 7500,
      priceId: "price_acme_pro",
      currency: "usd",
      source: "webhook",
    });

    expect(out.unrouted).toBe(false);
    expect(out.alreadyBooked).toBe(false);
    expect(h.ledgerCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        stripeInvoiceId: "in_1",
        stripeCustomerId: "cus_1",
        brandId: "b_acme",
        userId: "u_cust",
        planId: "p_pro",
        currency: "usd",
        totalCents: 7500,
        platformCents: 5000,
        brandCents: 2500,
        source: "webhook",
      }),
    });
    // The wallet is fed from the row that was just written — nothing else.
    expect(h.credit).toHaveBeenCalledWith(expect.objectContaining({ id: "l1", brandCents: 2500 }));
    expect(out.credited).toBe(2500);
  });

  it("splits in proportion to what was actually paid — a 50% coupon halves both shares", async () => {
    h.addonFindFirst.mockResolvedValue(proAddon);
    h.couponFindFirst.mockResolvedValue({ id: "cp_half" });
    await recordPaidInvoice({
      invoiceId: "in_2",
      customerId: "cus_1",
      amountPaidCents: 3750,
      priceId: "price_acme_pro",
      stripeCouponId: "HALF",
    });
    expect(h.ledgerCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({ totalCents: 3750, platformCents: 2500, brandCents: 1250, couponId: "cp_half" }),
    });
  });

  it("gives the brand nothing when the invoice billed the platform's own Price", async () => {
    h.addonFindFirst.mockResolvedValue(null);
    h.planFindUnique.mockResolvedValue({ priceCents: 5000, currency: "usd" });
    await recordPaidInvoice({ invoiceId: "in_3", customerId: "cus_1", amountPaidCents: 5000, priceId: "price_base" });
    expect(h.ledgerCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({ totalCents: 5000, platformCents: 5000, brandCents: 0, planId: "p_pro" }),
    });
    expect(h.addonFindUnique).not.toHaveBeenCalled();
  });

  it("falls back to the customer's current plan when no Price is known", async () => {
    h.addonFindUnique.mockResolvedValue(proAddon);
    await recordPaidInvoice({ invoiceId: "in_4", customerId: "cus_1", amountPaidCents: 7500 });
    expect(h.addonFindUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { brandId_planId: { brandId: "b_acme", planId: "p_pro" } } }),
    );
    expect(h.ledgerCreate).toHaveBeenCalledWith({ data: expect.objectContaining({ brandCents: 2500 }) });
  });

  it("names the discount the account holds when the invoice carries no coupon", async () => {
    h.addonFindFirst.mockResolvedValue(proAddon);
    h.profileFindUnique.mockResolvedValue({ subscriptionPlanId: "p_pro", activeCouponRedemptionId: "r1" });
    h.redemptionFindUnique.mockResolvedValue({ couponId: "cp_welcome" });
    await recordPaidInvoice({ invoiceId: "in_5", customerId: "cus_1", amountPaidCents: 7500, priceId: "price_acme_pro" });
    expect(h.ledgerCreate).toHaveBeenCalledWith({ data: expect.objectContaining({ couponId: "cp_welcome" }) });
  });
});

describe("recordPaidInvoice — placing and repeating", () => {
  // The whole point of the index: a payment nobody can place is reported as
  // such, so the webhook parks it. Nothing is written against a guess.
  it("reports an invoice unrouted when no brand holds the Stripe customer", async () => {
    h.resolve.mockResolvedValue(null);
    const out = await recordPaidInvoice({ invoiceId: "in_9", customerId: "cus_stranger", amountPaidCents: 7500 });
    expect(out).toMatchObject({ unrouted: true, ledger: null, credited: 0 });
    expect(h.ledgerCreate).not.toHaveBeenCalled();
    expect(h.credit).not.toHaveBeenCalled();
  });

  it("books an invoice once: a second path finds the row and only re-offers the wallet credit", async () => {
    const existing = { id: "l1", stripeInvoiceId: "in_1", brandId: "b_acme", userId: "u_cust", brandCents: 2500, currency: "usd", planId: "p_pro" };
    h.ledgerFindUnique.mockResolvedValue(existing);
    h.credit.mockResolvedValue(0);
    const out = await recordPaidInvoice({ invoiceId: "in_1", customerId: "cus_1", amountPaidCents: 7500 });
    expect(out.alreadyBooked).toBe(true);
    expect(h.ledgerCreate).not.toHaveBeenCalled();
    expect(h.credit).toHaveBeenCalledWith(existing);
    expect(h.resolve).not.toHaveBeenCalled();
  });

  it("settles a race between two paths by the invoice id", async () => {
    h.addonFindFirst.mockResolvedValue(proAddon);
    h.ledgerCreate.mockRejectedValueOnce(
      new Prisma.PrismaClientKnownRequestError("duplicate", { code: "P2002", clientVersion: "5.22.0" }),
    );
    const theirs = { id: "l_theirs", stripeInvoiceId: "in_1", brandId: "b_acme", userId: "u_cust", brandCents: 2500, currency: "usd", planId: "p_pro" };
    h.ledgerFindUnique.mockResolvedValueOnce(null).mockResolvedValue(theirs);
    const out = await recordPaidInvoice({ invoiceId: "in_1", customerId: "cus_1", amountPaidCents: 7500, priceId: "price_acme_pro" });
    expect(out.alreadyBooked).toBe(true);
    expect(out.ledger).toBe(theirs);
  });

  it("ignores empty or unpaid invoices", async () => {
    const out = await recordPaidInvoice({ invoiceId: "in_0", customerId: "cus_1", amountPaidCents: 0 });
    expect(out).toMatchObject({ ledger: null, credited: 0 });
    expect(h.resolve).not.toHaveBeenCalled();
  });
});

describe("recordRefund", () => {
  it("notes the refunded share of the payment, cumulatively, and leaves the row", async () => {
    h.ledgerFindUnique.mockResolvedValue({ id: "l1", totalCents: 7500, refundedCents: 0 });
    await recordRefund({ invoiceId: "in_1", chargeAmountCents: 7500, amountRefundedCents: 3750 });
    expect(h.ledgerUpdate).toHaveBeenCalledWith({ where: { id: "l1" }, data: { refundedCents: 3750 } });
  });

  it("changes nothing on a replayed refund event", async () => {
    h.ledgerFindUnique.mockResolvedValue({ id: "l1", totalCents: 7500, refundedCents: 3750 });
    await recordRefund({ invoiceId: "in_1", chargeAmountCents: 7500, amountRefundedCents: 3750 });
    expect(h.ledgerUpdate).not.toHaveBeenCalled();
  });
});

describe("ledgerSummary", () => {
  it("sums the window per currency, and lists each brand's share", async () => {
    h.ledgerGroupBy.mockResolvedValue([
      { brandId: "b_acme", currency: "usd", _count: { _all: 2 }, _sum: { totalCents: 15000, platformCents: 10000, brandCents: 5000, refundedCents: 0 } },
      { brandId: "b_globex", currency: "usd", _count: { _all: 1 }, _sum: { totalCents: 5000, platformCents: 5000, brandCents: 0, refundedCents: 5000 } },
    ]);
    const out = await ledgerSummary({ from: new Date("2026-09-01"), to: new Date("2026-10-01") });
    expect(out.totals).toEqual([
      { currency: "usd", payments: 3, totalCents: 20000, platformCents: 15000, brandCents: 5000, refundedCents: 5000 },
    ]);
    expect(out.byBrand.map((b) => b.brandId)).toEqual(["b_acme", "b_globex"]);
  });
});
