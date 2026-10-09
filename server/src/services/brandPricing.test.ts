import { describe, it, expect, vi, beforeEach } from "vitest";

// Brand price add-on: which Stripe Price a customer lands on, add-on changes that leave existing subscribers on the
// Price they joined on, the history that keeps their split, base-price moves, and only an approved brand selling at
// its own price.

const h = vi.hoisted(() => ({
  brandFindUnique: vi.fn(),
  planFindUnique: vi.fn(),
  planFindMany: vi.fn(),
  addonFindMany: vi.fn(),
  addonFindUnique: vi.fn(),
  addonUpsert: vi.fn(),
  addonUpdate: vi.fn(),
  priceCreate: vi.fn(),
  priceFindUnique: vi.fn(),
  userFindMany: vi.fn(),
  createStripePrice: vi.fn(),
  archiveStripePrice: vi.fn(),
  getSubscription: vi.fn(),
  notifyIn: vi.fn(),
  audit: vi.fn(),
}));

vi.mock("../prisma.js", () => ({
  prisma: {
    brand: { findUnique: h.brandFindUnique },
    subscriptionPlan: { findUnique: h.planFindUnique, findMany: h.planFindMany },
    brandPlanAddon: {
      findMany: h.addonFindMany,
      findUnique: h.addonFindUnique,
      upsert: h.addonUpsert,
      update: h.addonUpdate,
    },
    brandPlanPrice: { create: h.priceCreate, findUnique: h.priceFindUnique },
    user: { findMany: h.userFindMany },
  },
}));
vi.mock("./tenantDb.js", async () => (await import("../test/tenantDbFake.js")).tenantDbFake({}));
vi.mock("./stripe.js", () => ({
  createStripePrice: h.createStripePrice,
  archiveStripePrice: h.archiveStripePrice,
  getSubscription: h.getSubscription,
  isStripeConfigured: () => true,
}));
vi.mock("./brands.js", () => ({ cachedBrand: () => null }));
vi.mock("./brandPlans.js", () => ({ livePlanSubscribers: async () => new Map([["p_pro", 3]]) }));
vi.mock("./audit.js", () => ({ audit: h.audit }));
vi.mock("./notifications.js", () => ({ notifyIn: h.notifyIn }));

const {
  stripePriceIdFor,
  setBrandAddon,
  listBrandPricing,
  brandAddonsFor,
  billedPriceCents,
  customerPlanPriceCents,
  refreshBrandPricesForPlan,
} = await import("./brandPricing.js");

const pro = {
  id: "p_pro",
  displayName: "Pro",
  priceCents: 19900,
  currency: "usd",
  interval: "month",
  intervalCount: 1,
  active: true,
  stripeProductId: "prod_pro",
  stripePriceId: "price_base_pro",
  sortOrder: 1,
  createdAt: new Date(),
};
const acme = { id: "b_acme", kind: "brand", planIds: [], addonEditable: true, maxAddonCents: null };
const actor = { id: "u1", email: "a@b.c" };

beforeEach(() => {
  vi.clearAllMocks();
  h.brandFindUnique.mockResolvedValue(acme);
  h.planFindUnique.mockResolvedValue(pro);
  h.planFindMany.mockResolvedValue([pro]);
  h.addonFindMany.mockResolvedValue([]);
  h.addonFindUnique.mockResolvedValue(null);
  h.addonUpsert.mockImplementation(async ({ create }: { create: Record<string, unknown> }) => create);
  h.priceCreate.mockResolvedValue({});
  h.priceFindUnique.mockResolvedValue(null);
  h.createStripePrice.mockResolvedValue("price_new");
  h.archiveStripePrice.mockResolvedValue(undefined);
  h.userFindMany.mockResolvedValue([{ id: "admin1" }]);
});

describe("stripePriceIdFor — the Price a new subscription lands on", () => {
  it("is the brand's Price when it adds something and the Price exists", async () => {
    h.addonFindUnique.mockResolvedValue({ addonCents: 2000, stripePriceId: "price_acme_pro" });
    expect(await stripePriceIdFor(pro, "b_acme")).toBe("price_acme_pro");
  });

  it("is the platform's Price with no add-on, no brand, or a Price not yet made", async () => {
    expect(await stripePriceIdFor(pro, "b_acme")).toBe("price_base_pro");
    expect(await stripePriceIdFor(pro, null)).toBe("price_base_pro");
    h.addonFindUnique.mockResolvedValue({ addonCents: 2000, stripePriceId: "" });
    expect(await stripePriceIdFor(pro, "b_acme")).toBe("price_base_pro");
  });

  it("is the platform's Price for a main-domain customer's row, even with an add-on on file", async () => {
    h.brandFindUnique.mockResolvedValue({ kind: "customer" });
    h.addonFindUnique.mockResolvedValue({ addonCents: 2000, stripePriceId: "price_acme_pro" });
    expect(await stripePriceIdFor(pro, "b_acme")).toBe("price_base_pro");
    expect(h.addonFindUnique).not.toHaveBeenCalled();
  });
});

describe("brandAddonsFor — the public plan list", () => {
  it("lists only add-ons checkout will really charge", async () => {
    h.addonFindMany.mockResolvedValue([
      { planId: "p_pro", addonCents: 2000, stripePriceId: "price_acme_pro" },
      { planId: "p_basic", addonCents: 500, stripePriceId: "" },
      { planId: "p_max", addonCents: 0, stripePriceId: "" },
    ]);
    expect([...(await brandAddonsFor("b_acme", ["p_pro", "p_basic", "p_max"]))]).toEqual([["p_pro", 2000]]);
  });

  it("is empty for a customer row", async () => {
    h.brandFindUnique.mockResolvedValue({ kind: "customer" });
    expect((await brandAddonsFor("b_acme", ["p_pro"])).size).toBe(0);
  });
});

describe("setBrandAddon", () => {
  it("makes a Price for base + add-on and remembers what it was sold at", async () => {
    const row = await setBrandAddon({ brandId: "b_acme", planId: "p_pro", addonCents: 2000, actor, asBrand: true });
    expect(h.createStripePrice).toHaveBeenCalledWith("prod_pro", 21900, "usd", "month", 1);
    expect(h.priceCreate).toHaveBeenCalledWith({
      data: { stripePriceId: "price_new", brandId: "b_acme", planId: "p_pro", baseCents: 19900, addonCents: 2000, currency: "usd" },
    });
    expect(row).toMatchObject({ basePriceCents: 19900, addonCents: 2000, brandPriceCents: 21900, stripeLinked: true, subscribers: 3 });
  });

  it("leaves existing subscribers on their Price: the old one is only archived, never swapped", async () => {
    h.addonFindUnique.mockResolvedValue({ addonCents: 1000, stripePriceId: "price_old" });
    await setBrandAddon({ brandId: "b_acme", planId: "p_pro", addonCents: 2500, actor, asBrand: true });
    expect(h.archiveStripePrice).toHaveBeenCalledWith("price_old");
    expect(h.getSubscription).not.toHaveBeenCalled();
  });

  it("keeps the live Price when the add-on didn't change", async () => {
    h.addonFindUnique.mockResolvedValue({ addonCents: 2000, stripePriceId: "price_live" });
    await setBrandAddon({ brandId: "b_acme", planId: "p_pro", addonCents: 2000, actor, asBrand: true });
    expect(h.createStripePrice).not.toHaveBeenCalled();
    expect(h.archiveStripePrice).not.toHaveBeenCalled();
    expect(h.addonUpsert).toHaveBeenCalledWith(expect.objectContaining({ update: { addonCents: 2000, stripePriceId: "price_live" } }));
  });

  it("clearing to 0 drops the brand Price — new customers pay the base", async () => {
    h.addonFindUnique.mockResolvedValue({ addonCents: 2000, stripePriceId: "price_live" });
    await setBrandAddon({ brandId: "b_acme", planId: "p_pro", addonCents: 0, actor, asBrand: true });
    expect(h.createStripePrice).not.toHaveBeenCalled();
    expect(h.archiveStripePrice).toHaveBeenCalledWith("price_live");
  });

  it("holds the brand's own admin to the editability switch and the cap; the super admin to neither", async () => {
    h.brandFindUnique.mockResolvedValue({ ...acme, addonEditable: false });
    await expect(setBrandAddon({ brandId: "b_acme", planId: "p_pro", addonCents: 100, actor, asBrand: true })).rejects.toThrow(
      /managed by the platform/,
    );
    h.brandFindUnique.mockResolvedValue({ ...acme, maxAddonCents: 1500 });
    await expect(setBrandAddon({ brandId: "b_acme", planId: "p_pro", addonCents: 2000, actor, asBrand: true })).rejects.toThrow(
      /at most 15\.00/,
    );
    await expect(setBrandAddon({ brandId: "b_acme", planId: "p_pro", addonCents: 2000, actor, asBrand: false })).resolves.toBeTruthy();
  });

  it("refuses a customer row and a plan the brand doesn't sell", async () => {
    h.brandFindUnique.mockResolvedValue({ ...acme, kind: "customer" });
    await expect(setBrandAddon({ brandId: "b_acme", planId: "p_pro", addonCents: 100, actor, asBrand: false })).rejects.toThrow(
      /approved brand/,
    );
    h.brandFindUnique.mockResolvedValue({ ...acme, planIds: ["p_other"] });
    await expect(setBrandAddon({ brandId: "b_acme", planId: "p_pro", addonCents: 100, actor, asBrand: false })).rejects.toThrow(
      /doesn't sell/,
    );
  });
});

describe("what a customer is billed", () => {
  it("is a brand Price's base + add-on as sold, even after the brand changed it", async () => {
    h.priceFindUnique.mockResolvedValue({ brandId: "b_acme", planId: "p_pro", baseCents: 19900, addonCents: 1000, currency: "usd" });
    expect(await billedPriceCents(pro, "price_acme_pro_2025")).toBe(20900);
  });

  it("is the plan's price on the platform's Price, or when Stripe can't be asked", async () => {
    expect(await billedPriceCents(pro, "price_base_pro")).toBe(19900);
    h.getSubscription.mockRejectedValue(new Error("down"));
    expect(await customerPlanPriceCents({ plan: pro, stripeSubscriptionId: "sub_1" })).toBe(19900);
  });

  it("follows the subscription's live Price", async () => {
    h.getSubscription.mockResolvedValue({ priceId: "price_acme_pro" });
    h.priceFindUnique.mockResolvedValue({ brandId: "b_acme", planId: "p_pro", baseCents: 19900, addonCents: 2000, currency: "usd" });
    expect(await customerPlanPriceCents({ plan: pro, stripeSubscriptionId: "sub_1" })).toBe(21900);
  });
});

describe("listBrandPricing", () => {
  it("shows base, add-on and brand price per plan the brand sells", async () => {
    h.addonFindMany.mockResolvedValue([{ planId: "p_pro", addonCents: 2000, stripePriceId: "price_acme_pro" }]);
    expect(await listBrandPricing("b_acme")).toEqual([
      expect.objectContaining({ planId: "p_pro", basePriceCents: 19900, addonCents: 2000, brandPriceCents: 21900, stripeLinked: true, subscribers: 3 }),
    ]);
  });
});

describe("refreshBrandPricesForPlan — the platform moved the base", () => {
  it("gives new customers a fresh base + add-on Price, keeps the old one billing, and tells the brand", async () => {
    h.planFindUnique.mockResolvedValue({ ...pro, priceCents: 24900 });
    h.addonFindMany.mockResolvedValue([{ id: "a1", brandId: "b_acme", planId: "p_pro", addonCents: 2000, stripePriceId: "price_old" }]);
    const out = await refreshBrandPricesForPlan("p_pro");
    expect(out).toEqual({ refreshed: 1, failed: 0 });
    expect(h.createStripePrice).toHaveBeenCalledWith("prod_pro", 26900, "usd", "month", 1);
    expect(h.priceCreate).toHaveBeenCalledWith({ data: expect.objectContaining({ baseCents: 24900, addonCents: 2000 }) });
    expect(h.addonUpdate).toHaveBeenCalledWith({ where: { id: "a1" }, data: { stripePriceId: "price_new" } });
    expect(h.archiveStripePrice).toHaveBeenCalledWith("price_old");
    expect(h.notifyIn).toHaveBeenCalledWith(expect.anything(), ["admin1"], expect.objectContaining({ link: "/dashboard/admin/pricing" }));
  });
});
