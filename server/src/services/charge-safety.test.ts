import { describe, it, expect, vi, beforeEach } from "vitest";

// One-time charge money-safety: bind the item to OUR invoice (a pending item got swept into a later renewal),
// call `pay` (finalize doesn't take money), and VOID on failed collection so it can't resurface on a later bill.

const invoices = {
  create: vi.fn(),
  finalizeInvoice: vi.fn(),
  pay: vi.fn(),
  voidInvoice: vi.fn(),
  del: vi.fn(),
};
const invoiceItems = { create: vi.fn() };
const subscriptions = { retrieve: vi.fn(), update: vi.fn() };
const subscriptionSchedules = { release: vi.fn() };
const paymentMethods = { list: vi.fn(async (): Promise<{ data: { id: string }[] }> => ({ data: [] })) };
const customers = { update: vi.fn(), retrieve: vi.fn() };

vi.mock("stripe", () => ({
  default: class {
    invoices = invoices;
    invoiceItems = invoiceItems;
    subscriptions = subscriptions;
    subscriptionSchedules = subscriptionSchedules;
    paymentMethods = paymentMethods;
    customers = customers;
  },
}));
vi.mock("../env.js", () => ({
  // Brand hosts resolve against these; the real module exports them, so a
  // mock that omits them fails to link for anything importing brandUrls.
  platformDomain: "hello22.ai",
  platformDomains: ["hello22.ai"],
  allowUnverifiedBrandDomains: false,
  canonicalApiBaseUrl: "https://api.test",
  env: { STRIPE_SECRET_KEY: "sk_test_fake", STRIPE_WEBHOOK_SECRET: "" },
}));

import { chargeOneTime, renewSubscriptionNow } from "./stripe.js";

beforeEach(() => {
  vi.clearAllMocks();
  invoices.create.mockResolvedValue({ id: "in_1", status: "draft" });
  invoiceItems.create.mockResolvedValue({ id: "ii_1" });
  invoices.finalizeInvoice.mockResolvedValue({ id: "in_1", status: "open" });
  invoices.pay.mockResolvedValue({ id: "in_1", status: "paid" });
  invoices.voidInvoice.mockResolvedValue({ id: "in_1", status: "void" });
  // Customer with a card saved but NO invoice-level default — the real-world
  // shape that broke the first attempt at this fix.
  customers.retrieve.mockResolvedValue({ id: "cus_1", invoice_settings: {} });
  paymentMethods.list.mockResolvedValue({ data: [{ id: "pm_card" }] });
});

describe("chargeOneTime — an upgrade delta must be collected NOW or disappear", () => {
  it("binds the line item to our own invoice (never left pending on the customer)", async () => {
    await chargeOneTime("cus_1", 600, "Upgrade to Basic", "aud");

    const item = invoiceItems.create.mock.calls[0][0];
    expect(item.invoice).toBe("in_1");
    expect(item.amount).toBe(600);
    // Invoice must exist before the item, or it cannot be bound to it.
    expect(invoices.create.mock.invocationCallOrder[0]).toBeLessThan(
      invoiceItems.create.mock.invocationCallOrder[0],
    );
  });

  it("pins a card ON the invoice — a standalone invoice does NOT inherit the subscription's card", async () => {
    // Customer invoice_settings default is unset (the subscription has one instead), so the invoice
    // must carry the card explicitly or `pay` fails with "no payment method".
    await chargeOneTime("cus_1", 2000, "Upgrade to Pro", "aud");

    expect(invoices.create.mock.calls[0][0].default_payment_method).toBe("pm_card");
  });

  it("prefers the customer's own invoice default when one is set", async () => {
    customers.retrieve.mockResolvedValue({
      id: "cus_1",
      invoice_settings: { default_payment_method: "pm_preferred" },
    });

    await chargeOneTime("cus_1", 2000, "Upgrade to Pro", "aud");

    expect(invoices.create.mock.calls[0][0].default_payment_method).toBe("pm_preferred");
    expect(paymentMethods.list).not.toHaveBeenCalled();
  });

  it("still attempts the charge when no card is on file, so Stripe reports the real reason", async () => {
    customers.retrieve.mockResolvedValue({ id: "cus_1", invoice_settings: {} });
    paymentMethods.list.mockResolvedValue({ data: [] });
    invoices.pay.mockRejectedValue(new Error("no attached payment method"));

    const { paid } = await chargeOneTime("cus_1", 2000, "Upgrade to Pro", "aud");

    expect(invoices.create.mock.calls[0][0].default_payment_method).toBeUndefined();
    expect(paid).toBe(false);
    expect(invoices.voidInvoice).toHaveBeenCalledWith("in_1");
  });

  it("actually charges the card — finalize alone never takes the money", async () => {
    const { paid } = await chargeOneTime("cus_1", 600, "Upgrade to Basic", "aud");

    expect(invoices.pay).toHaveBeenCalledWith("in_1");
    expect(paid).toBe(true);
  });

  it("does not double-charge an invoice Stripe already settled on finalize", async () => {
    invoices.finalizeInvoice.mockResolvedValue({ id: "in_1", status: "paid" });

    const { paid } = await chargeOneTime("cus_1", 600, "Upgrade to Basic", "aud");

    expect(invoices.pay).not.toHaveBeenCalled();
    expect(paid).toBe(true);
  });

  it("voids the invoice when the card declines, so nothing rolls into a later bill", async () => {
    invoices.pay.mockRejectedValue(new Error("card_declined"));

    const { paid } = await chargeOneTime("cus_1", 600, "Upgrade to Basic", "aud");

    expect(paid).toBe(false);
    expect(invoices.voidInvoice).toHaveBeenCalledWith("in_1");
  });

  it("charges nothing for a zero/negative amount", async () => {
    const { paid } = await chargeOneTime("cus_1", 0, "nothing", "aud");

    expect(paid).toBe(true);
    expect(invoices.create).not.toHaveBeenCalled();
    expect(invoiceItems.create).not.toHaveBeenCalled();
  });
});

describe("renewSubscriptionNow — a raced renewal must not bill twice", () => {
  const liveSub = {
    id: "sub_1",
    status: "active",
    current_period_end: 1_800_000_000,
    schedule: null,
    default_payment_method: "pm_1",
    items: { data: [{ id: "si_1", price: { id: "price_1" } }] },
  };

  beforeEach(() => {
    subscriptions.retrieve.mockResolvedValue(liveSub);
    subscriptions.update.mockResolvedValue({ status: "active", current_period_end: 1_802_000_000 });
  });

  it("sends an idempotency key derived from the cycle being replaced", async () => {
    await renewSubscriptionNow("sub_1", { dedupeConcurrent: true });

    expect(subscriptions.update.mock.calls[0][2].idempotencyKey).toBe("renew:sub_1:1800000000");
  });

  it("two racing automatic renewals of the same cycle send the SAME key", async () => {
    await Promise.all([
      renewSubscriptionNow("sub_1", { dedupeConcurrent: true }),
      renewSubscriptionNow("sub_1", { dedupeConcurrent: true }),
    ]);

    const [a, b] = subscriptions.update.mock.calls.map((c) => c[2].idempotencyKey);
    expect(a).toBe(b);
  });

  it("a user-initiated retry sends NO key — Stripe caches declines, so a fixed card must get a real attempt", async () => {
    await renewSubscriptionNow("sub_1");

    expect(subscriptions.update.mock.calls[0][2].idempotencyKey).toBeUndefined();
  });
});
