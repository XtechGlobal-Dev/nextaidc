import { describe, it, expect, vi, beforeEach } from "vitest";
import { Prisma } from "@prisma/client";

// Brand wallet: a paid invoice's brand share (decided on the platform ledger row) lands as a
// credit exactly once; a payout is a negative entry that can never exceed the balance.

const h = vi.hoisted(() => ({
  profileFindFirst: vi.fn(),
  addonFindFirst: vi.fn(),
  addonFindUnique: vi.fn(),
  entryCreate: vi.fn(),
  entryGroupBy: vi.fn(),
  entryFindMany: vi.fn(),
  entryFindUnique: vi.fn(),
  brandFindUnique: vi.fn(),
  userFindMany: vi.fn(),
  planFindMany: vi.fn(),
  planFindUnique: vi.fn(),
}));

vi.mock("../prisma.js", () => ({
  prisma: {
    profile: { findFirst: h.profileFindFirst },
    brandPlanAddon: { findFirst: h.addonFindFirst, findUnique: h.addonFindUnique },
    brandWalletEntry: {
      create: h.entryCreate,
      groupBy: h.entryGroupBy,
      findMany: h.entryFindMany,
      findUnique: h.entryFindUnique,
    },
    brand: { findUnique: h.brandFindUnique },
    user: { findMany: h.userFindMany },
    subscriptionPlan: { findMany: h.planFindMany, findUnique: h.planFindUnique },
  },
}));
vi.mock("./audit.js", () => ({ audit: vi.fn(async () => undefined) }));

const { creditWalletFromLedger, walletBalances, recordPayout, reverseCreditForRefund } = await import(
  "./brandWallet.js"
);

beforeEach(() => {
  vi.clearAllMocks();
  h.entryFindUnique.mockResolvedValue(null);
  h.entryCreate.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
    id: "e1",
    createdAt: new Date(),
    ...data,
  }));
});

describe("creditWalletFromLedger", () => {
  const row = {
    brandId: "b_acme",
    userId: "u_cust",
    stripeInvoiceId: "in_1",
    brandCents: 2500,
    currency: "usd",
    planId: "p_pro",
  };

  it("books the ledger row's brand share as a credit, named by the plan", async () => {
    h.planFindUnique.mockResolvedValue({ displayName: "Pro" });
    expect(await creditWalletFromLedger(row)).toBe(2500);
    expect(h.entryCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          brandId: "b_acme",
          type: "credit",
          amountCents: 2500,
          currency: "usd",
          stripeInvoiceId: "in_1",
          customerId: "u_cust",
          planId: "p_pro",
          note: "Pro · addon share of a paid invoice",
        }),
      }),
    );
  });

  // The split was decided when the payment was written down; a payment with
  // no brand share (the platform's own Price) simply credits nothing.
  it("books nothing for a payment with no brand share", async () => {
    expect(await creditWalletFromLedger({ ...row, brandCents: 0 })).toBe(0);
    expect(h.entryCreate).not.toHaveBeenCalled();
  });

  it("books an invoice once, whichever path sees it second", async () => {
    h.planFindUnique.mockResolvedValue({ displayName: "Pro" });
    h.entryCreate.mockRejectedValueOnce(
      new Prisma.PrismaClientKnownRequestError("duplicate", { code: "P2002", clientVersion: "5.22.0" }),
    );
    expect(await creditWalletFromLedger(row)).toBe(0);
  });
});

describe("walletBalances", () => {
  it("sums the ledger per currency and splits credits from payouts", async () => {
    h.entryGroupBy.mockResolvedValue([
      { currency: "usd", type: "credit", _sum: { amountCents: 5000 } },
      { currency: "usd", type: "payout", _sum: { amountCents: -3000 } },
      { currency: "aud", type: "credit", _sum: { amountCents: 800 } },
    ]);
    expect(await walletBalances("b_acme")).toEqual([
      { currency: "aud", balanceCents: 800, creditedCents: 800, paidOutCents: 0 },
      { currency: "usd", balanceCents: 2000, creditedCents: 5000, paidOutCents: 3000 },
    ]);
  });
});

describe("recordPayout", () => {
  const actor = { id: "u_super", email: "superadmin@ai.com" };

  it("refuses more than the wallet holds in that currency", async () => {
    h.brandFindUnique.mockResolvedValue({ id: "b_acme", name: "Acme" });
    h.entryGroupBy.mockResolvedValue([{ currency: "usd", type: "credit", _sum: { amountCents: 2000 } }]);
    await expect(
      recordPayout({ brandId: "b_acme", amountCents: 2500, currency: "usd", actor }),
    ).rejects.toThrow(/more than the wallet holds/);
    expect(h.entryCreate).not.toHaveBeenCalled();
  });

  it("records a payout as a negative entry with its reference", async () => {
    h.brandFindUnique.mockResolvedValue({ id: "b_acme", name: "Acme" });
    h.entryGroupBy.mockResolvedValue([{ currency: "usd", type: "credit", _sum: { amountCents: 2000 } }]);
    const entry = await recordPayout({
      brandId: "b_acme",
      amountCents: 2000,
      currency: "USD",
      reference: "TRF-42",
      note: "June",
      actor,
    });
    expect(entry.type).toBe("payout");
    expect(entry.amountCents).toBe(-2000);
    expect(entry.currency).toBe("usd");
    expect(entry.reference).toBe("TRF-42");
    expect(h.entryCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ type: "payout", amountCents: -2000, createdById: "u_super" }),
      }),
    );
  });

  it("validates the amount and currency", async () => {
    await expect(
      recordPayout({ brandId: "b_acme", amountCents: 0, currency: "usd", actor }),
    ).rejects.toThrow(/amount/);
    await expect(
      recordPayout({ brandId: "b_acme", amountCents: 100, currency: "dollars", actor }),
    ).rejects.toThrow(/currency/);
  });
});

describe("reverseCreditForRefund", () => {
  const credit = {
    id: "e_credit",
    brandId: "b_acme",
    type: "credit",
    amountCents: 2000,
    currency: "usd",
    stripeInvoiceId: "in_1",
    customerId: "u_cust",
    planId: "p_pro",
  };

  it("reverses the credit in proportion to the refund", async () => {
    h.entryFindUnique.mockResolvedValue(credit);
    h.entryFindMany.mockResolvedValue([]);
    // Half of a 219.00 charge refunded → half of the 20.00 credit undone.
    const out = await reverseCreditForRefund({
      invoiceId: "in_1",
      chargeId: "ch_1",
      chargeAmountCents: 21900,
      amountRefundedCents: 10950,
    });
    expect(out.reversed).toBe(1000);
    expect(h.entryCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          brandId: "b_acme",
          type: "reversal",
          amountCents: -1000,
          currency: "usd",
          relatedInvoiceId: "in_1",
          reference: "ch_1",
          customerId: "u_cust",
          planId: "p_pro",
        }),
      }),
    );
  });

  it("books only the difference on a second partial refund, and nothing on a replay", async () => {
    h.entryFindUnique.mockResolvedValue(credit);
    // 10.00 already reversed; Stripe now says 75% refunded in total → 15.00 should be.
    h.entryFindMany.mockResolvedValue([{ amountCents: -1000 }]);
    const out = await reverseCreditForRefund({
      invoiceId: "in_1",
      chargeId: "ch_1",
      chargeAmountCents: 21900,
      amountRefundedCents: 16425,
    });
    expect(out.reversed).toBe(500);

    // The same event again: everything it describes is already booked.
    h.entryFindMany.mockResolvedValue([{ amountCents: -1000 }, { amountCents: -500 }]);
    h.entryCreate.mockClear();
    const replay = await reverseCreditForRefund({
      invoiceId: "in_1",
      chargeId: "ch_1",
      chargeAmountCents: 21900,
      amountRefundedCents: 16425,
    });
    expect(replay.reversed).toBe(0);
    expect(h.entryCreate).not.toHaveBeenCalled();
  });

  it("never reverses more than was credited, and ignores invoices it never credited", async () => {
    h.entryFindUnique.mockResolvedValue(credit);
    h.entryFindMany.mockResolvedValue([]);
    const full = await reverseCreditForRefund({
      invoiceId: "in_1",
      chargeId: "ch_1",
      chargeAmountCents: 21900,
      amountRefundedCents: 50_000, // over-refund shapes still cap at the credit
    });
    expect(full.reversed).toBe(2000);

    h.entryFindUnique.mockResolvedValue(null);
    const none = await reverseCreditForRefund({
      invoiceId: "in_platform",
      chargeId: "ch_2",
      chargeAmountCents: 19900,
      amountRefundedCents: 19900,
    });
    expect(none.reversed).toBe(0);
  });
});
