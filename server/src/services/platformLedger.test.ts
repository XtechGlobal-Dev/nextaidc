import { describe, it, expect, vi, beforeEach } from "vitest";
import { Prisma } from "@prisma/client";

// Platform ledger: one paid invoice → one row. Brands add no markup any more (docs/brand-as-customer-plan.md),
// so every payment is the platform's: a $50 plan paid in full books $50 platform, $0 brand — whichever Stripe
// Price the invoice billed.

const h = vi.hoisted(() => ({
  ledgerFindUnique: vi.fn(),
  ledgerCreate: vi.fn(),
  ledgerUpdate: vi.fn(),
  ledgerGroupBy: vi.fn(),
  profileFindUnique: vi.fn(),
  planFindUnique: vi.fn(),
  couponFindFirst: vi.fn(),
  redemptionFindUnique: vi.fn(),
  resolve: vi.fn(),
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

const { recordPaidInvoice, recordRefund, ledgerSummary } = await import("./platformLedger.js");

/** A customer of bostan&co on the $50 "Professional" plan. */
const acmeOwner = { brandId: "b_acme", userId: "u_cust" };

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
  h.planFindUnique.mockResolvedValue({ currency: "usd" });
  h.profileFindUnique.mockResolvedValue({ subscriptionPlanId: "p_pro", activeCouponRedemptionId: null });
  h.resolve.mockResolvedValue(acmeOwner);
});

describe("recordPaidInvoice — every payment is the platform's", () => {
  it("books the whole payment to the platform, nothing to the brand", async () => {
    const out = await recordPaidInvoice({
      invoiceId: "in_1",
      customerId: "cus_1",
      amountPaidCents: 5000,
      priceId: "price_base",
      currency: "usd",
      source: "webhook",
    });

    expect(out).toMatchObject({ unrouted: false, alreadyBooked: false, credited: 0 });
    expect(h.ledgerCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        stripeInvoiceId: "in_1",
        stripeCustomerId: "cus_1",
        brandId: "b_acme",
        userId: "u_cust",
        planId: "p_pro",
        currency: "usd",
        totalCents: 5000,
        platformCents: 5000,
        brandCents: 0,
        source: "webhook",
      }),
    });
  });

  it("is still all the platform's on an old marked-up Price, and with a coupon", async () => {
    h.couponFindFirst.mockResolvedValue({ id: "cp_half" });
    await recordPaidInvoice({
      invoiceId: "in_2",
      customerId: "cus_1",
      amountPaidCents: 3750,
      priceId: "price_acme_pro_marked_up",
      stripeCouponId: "HALF",
    });
    expect(h.ledgerCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({ totalCents: 3750, platformCents: 3750, brandCents: 0, couponId: "cp_half" }),
    });
  });

  it("takes the currency from the customer's plan when the invoice doesn't say", async () => {
    h.planFindUnique.mockResolvedValue({ currency: "aud" });
    await recordPaidInvoice({ invoiceId: "in_4", customerId: "cus_1", amountPaidCents: 5000 });
    expect(h.ledgerCreate).toHaveBeenCalledWith({ data: expect.objectContaining({ currency: "aud", planId: "p_pro" }) });
  });

  it("names the discount the account holds when the invoice carries no coupon", async () => {
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
  });

  it("books an invoice once: a second path finds the row and writes nothing", async () => {
    const existing = { id: "l1", stripeInvoiceId: "in_1", brandId: "b_acme", userId: "u_cust", brandCents: 0, currency: "usd", planId: "p_pro" };
    h.ledgerFindUnique.mockResolvedValue(existing);
    const out = await recordPaidInvoice({ invoiceId: "in_1", customerId: "cus_1", amountPaidCents: 7500 });
    expect(out.alreadyBooked).toBe(true);
    expect(h.ledgerCreate).not.toHaveBeenCalled();
    expect(h.resolve).not.toHaveBeenCalled();
  });

  it("settles a race between two paths by the invoice id", async () => {
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
