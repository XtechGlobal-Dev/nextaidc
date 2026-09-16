import { describe, it, expect, vi, beforeEach } from "vitest";

// Brand pricing: which Stripe Price a customer lands on, addon changes that leave existing
// subscribers alone, base-price moves, migration, and the customer dashboard telling the truth.

const h = vi.hoisted(() => ({
  brandFindUnique: vi.fn(),
  planFindUnique: vi.fn(),
  planFindMany: vi.fn(),
  addonFindMany: vi.fn(),
  addonFindUnique: vi.fn(),
  addonUpsert: vi.fn(),
  addonUpdate: vi.fn(),
  profileGroupBy: vi.fn(),
  profileCount: vi.fn(),
  profileFindMany: vi.fn(),
  userFindMany: vi.fn(),
  createStripePrice: vi.fn(),
  archiveStripePrice: vi.fn(),
  getSubscription: vi.fn(),
  swapSubscriptionPriceNow: vi.fn(),
  notify: vi.fn(),
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
    profile: { groupBy: h.profileGroupBy, count: h.profileCount, findMany: h.profileFindMany },
    user: { findMany: h.userFindMany },
  },
}));
vi.mock("./tenantDb.js", async () =>
  (await import("../test/tenantDbFake.js")).tenantDbFake({}),
);
vi.mock("./stripe.js", () => ({
  createStripePrice: h.createStripePrice,
  archiveStripePrice: h.archiveStripePrice,
  getSubscription: h.getSubscription,
  swapSubscriptionPriceNow: h.swapSubscriptionPriceNow,
  isStripeConfigured: () => true,
}));
vi.mock("./audit.js", () => ({ audit: vi.fn(async () => undefined) }));
vi.mock("./notifications.js", () => ({ notify: h.notify }));

const {
  stripePriceIdFor,
  setBrandAddon,
  listBrandPricing,
  brandAddonsFor,
  customerPlanPriceCents,
  refreshBrandPricesForPlan,
  applyBrandPriceToSubscribers,
  brandAddonOnPrice,
  livePriceId,
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
const acme = { id: "b_acme", name: "Acme", planIds: [], addonEditable: true, maxAddonCents: null };
const actor = { id: "u1", email: "a@b.c" };

beforeEach(() => {
  vi.clearAllMocks();
  h.brandFindUnique.mockResolvedValue(acme);
  h.planFindUnique.mockResolvedValue(pro);
  h.planFindMany.mockResolvedValue([pro]);
  h.addonFindMany.mockResolvedValue([]);
  h.addonFindUnique.mockResolvedValue(null);
  h.addonUpdate.mockResolvedValue({});
  h.profileGroupBy.mockResolvedValue([]);
  h.profileCount.mockResolvedValue(0);
  h.profileFindMany.mockResolvedValue([]);
  h.userFindMany.mockResolvedValue([]);
  h.createStripePrice.mockResolvedValue("price_new");
  h.archiveStripePrice.mockResolvedValue(undefined);
  h.swapSubscriptionPriceNow.mockResolvedValue({ currentPeriodEnd: null });
  h.notify.mockResolvedValue(undefined);
  h.addonUpsert.mockImplementation(async ({ create }: { create: Record<string, unknown> }) => ({
    id: "a1",
    ...create,
  }));
});

describe("stripePriceIdFor", () => {
  it("is the platform's Price for a platform-level customer", async () => {
    expect(await stripePriceIdFor(pro, null)).toBe("price_base_pro");
    expect(h.addonFindUnique).not.toHaveBeenCalled();
  });

  it("is the brand's Price only when the brand adds something and the Price exists", async () => {
    h.addonFindUnique.mockResolvedValue({ addonCents: 2000, stripePriceId: "price_acme_pro" });
    expect(await stripePriceIdFor(pro, "b_acme")).toBe("price_acme_pro");

    h.addonFindUnique.mockResolvedValue({ addonCents: 0, stripePriceId: "price_stale" });
    expect(await stripePriceIdFor(pro, "b_acme")).toBe("price_base_pro");

    // Addon saved before the plan reached Stripe: sell at base rather than fail.
    h.addonFindUnique.mockResolvedValue({ addonCents: 2000, stripePriceId: "" });
    expect(await stripePriceIdFor(pro, "b_acme")).toBe("price_base_pro");
  });
});

describe("setBrandAddon", () => {
  it("creates a Stripe Price for base + addon under the plan's product", async () => {
    const row = await setBrandAddon({
      brandId: "b_acme",
      planId: "p_pro",
      addonCents: 2000,
      asBrand: true,
      actor,
    });
    expect(h.createStripePrice).toHaveBeenCalledWith("prod_pro", 21900, "usd", "month", 1);
    expect(row.brandPriceCents).toBe(21900);
    expect(row.stripeLinked).toBe(true);
    expect(h.addonUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: { brandId: "b_acme", planId: "p_pro", addonCents: 2000, stripePriceId: "price_new" },
      }),
    );
  });

  it("archives the previous brand Price when the addon changes", async () => {
    h.addonFindUnique.mockResolvedValue({ addonCents: 1000, stripePriceId: "price_old" });
    await setBrandAddon({ brandId: "b_acme", planId: "p_pro", addonCents: 2000, asBrand: false, actor });
    expect(h.createStripePrice).toHaveBeenCalled();
    expect(h.archiveStripePrice).toHaveBeenCalledWith("price_old");
  });

  it("keeps the live Price when the addon is saved unchanged", async () => {
    h.addonFindUnique.mockResolvedValue({ addonCents: 2000, stripePriceId: "price_old" });
    await setBrandAddon({ brandId: "b_acme", planId: "p_pro", addonCents: 2000, asBrand: false, actor });
    expect(h.createStripePrice).not.toHaveBeenCalled();
    expect(h.archiveStripePrice).not.toHaveBeenCalled();
  });

  it("clearing to 0 retires the brand Price and sells at the platform price", async () => {
    h.addonFindUnique.mockResolvedValue({ addonCents: 2000, stripePriceId: "price_old" });
    const row = await setBrandAddon({ brandId: "b_acme", planId: "p_pro", addonCents: 0, asBrand: false, actor });
    expect(h.createStripePrice).not.toHaveBeenCalled();
    expect(h.archiveStripePrice).toHaveBeenCalledWith("price_old");
    expect(row.addonCents).toBe(0);
    expect(row.stripeLinked).toBe(false);
  });

  it("honours the brand's editability and cap for the brand's own admin only", async () => {
    h.brandFindUnique.mockResolvedValue({ ...acme, addonEditable: false });
    await expect(
      setBrandAddon({ brandId: "b_acme", planId: "p_pro", addonCents: 500, asBrand: true, actor }),
    ).rejects.toThrow(/managed by the platform/);
    await expect(
      setBrandAddon({ brandId: "b_acme", planId: "p_pro", addonCents: 500, asBrand: false, actor }),
    ).resolves.toBeTruthy();

    h.brandFindUnique.mockResolvedValue({ ...acme, maxAddonCents: 1000 });
    await expect(
      setBrandAddon({ brandId: "b_acme", planId: "p_pro", addonCents: 1500, asBrand: true, actor }),
    ).rejects.toThrow(/at most 1000 cents/);
  });

  it("refuses a plan the brand doesn't sell, an inactive plan and a bad amount", async () => {
    h.brandFindUnique.mockResolvedValue({ ...acme, planIds: ["p_basic"] });
    await expect(
      setBrandAddon({ brandId: "b_acme", planId: "p_pro", addonCents: 500, asBrand: false, actor }),
    ).rejects.toThrow(/doesn't sell/);

    h.brandFindUnique.mockResolvedValue(acme);
    h.planFindUnique.mockResolvedValue({ ...pro, active: false });
    await expect(
      setBrandAddon({ brandId: "b_acme", planId: "p_pro", addonCents: 500, asBrand: false, actor }),
    ).rejects.toThrow(/isn't available/);

    await expect(
      setBrandAddon({ brandId: "b_acme", planId: "p_pro", addonCents: -1, asBrand: false, actor }),
    ).rejects.toThrow(/0 or more/);
  });

  it("saves the addon without a Price when the plan isn't in Stripe yet", async () => {
    h.planFindUnique.mockResolvedValue({ ...pro, stripeProductId: null });
    const row = await setBrandAddon({ brandId: "b_acme", planId: "p_pro", addonCents: 2000, asBrand: false, actor });
    expect(h.createStripePrice).not.toHaveBeenCalled();
    expect(row.stripeLinked).toBe(false);
    expect(row.planLinked).toBe(false);
  });
});

describe("listBrandPricing / brandAddonsFor", () => {
  it("merges the brand's addons and subscriber counts onto its plan list", async () => {
    h.addonFindMany.mockResolvedValue([{ planId: "p_pro", addonCents: 2000, stripePriceId: "price_acme_pro" }]);
    h.profileGroupBy.mockResolvedValue([{ subscriptionPlanId: "p_pro", _count: { _all: 3 } }]);
    const rows = await listBrandPricing("b_acme");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      planId: "p_pro",
      basePriceCents: 19900,
      addonCents: 2000,
      brandPriceCents: 21900,
      stripeLinked: true,
      planLinked: true,
      subscribers: 3,
    });
  });

  it("maps only non-zero addons for the public plan list", async () => {
    h.addonFindMany.mockResolvedValue([
      { planId: "p_pro", addonCents: 2000 },
      { planId: "p_basic", addonCents: 0 },
    ]);
    const map = await brandAddonsFor("b_acme", ["p_pro", "p_basic"]);
    expect([...map.entries()]).toEqual([["p_pro", 2000]]);
    expect((await brandAddonsFor(null, ["p_pro"])).size).toBe(0);
  });
});

describe("customerPlanPriceCents / brandAddonOnPrice / livePriceId", () => {
  it("shows the brand price only when the subscription really is on the brand's Price", async () => {
    h.addonFindUnique.mockResolvedValue({ addonCents: 2000, stripePriceId: "price_acme_pro" });
    h.getSubscription.mockResolvedValue({ priceId: "price_acme_pro" });
    expect(
      await customerPlanPriceCents({ plan: pro, brandId: "b_acme", stripeSubscriptionId: "sub_1" }),
    ).toBe(21900);

    // Subscribed before the addon existed: still billed the base, so say so.
    h.getSubscription.mockResolvedValue({ priceId: "price_base_pro" });
    expect(
      await customerPlanPriceCents({ plan: pro, brandId: "b_acme", stripeSubscriptionId: "sub_1" }),
    ).toBe(19900);
  });

  it("falls back to the base price without a brand, a subscription, or Stripe", async () => {
    expect(await customerPlanPriceCents({ plan: pro, brandId: null, stripeSubscriptionId: "sub_1" })).toBe(19900);
    expect(await customerPlanPriceCents({ plan: pro, brandId: "b_acme", stripeSubscriptionId: null })).toBe(19900);
    h.addonFindUnique.mockResolvedValue({ addonCents: 2000, stripePriceId: "price_acme_pro" });
    h.getSubscription.mockRejectedValue(new Error("stripe down"));
    expect(await customerPlanPriceCents({ plan: pro, brandId: "b_acme", stripeSubscriptionId: "sub_1" })).toBe(19900);
  });

  it("reports the addon on a Price only when that Price is the brand's", async () => {
    h.addonFindUnique.mockResolvedValue({ addonCents: 2000, stripePriceId: "price_acme_pro" });
    expect(await brandAddonOnPrice("p_pro", "b_acme", "price_acme_pro")).toBe(2000);
    expect(await brandAddonOnPrice("p_pro", "b_acme", "price_base_pro")).toBe(0);
    expect(await brandAddonOnPrice("p_pro", null, "price_acme_pro")).toBe(0);
    h.getSubscription.mockRejectedValue(new Error("nope"));
    expect(await livePriceId("sub_1")).toBeNull();
    expect(await livePriceId(null)).toBeNull();
  });
});

describe("refreshBrandPricesForPlan", () => {
  it("rebuilds every brand Price on the new base and tells the brand's admins", async () => {
    h.addonFindMany.mockResolvedValue([
      { id: "a1", brandId: "b_acme", planId: "p_pro", addonCents: 2000, stripePriceId: "price_old" },
      { id: "a2", brandId: "b_other", planId: "p_pro", addonCents: 0, stripePriceId: "" },
    ]);
    h.userFindMany.mockResolvedValue([{ id: "u_admin" }]);

    const out = await refreshBrandPricesForPlan("p_pro");

    expect(out).toEqual({ refreshed: 1, failed: 0 });
    expect(h.createStripePrice).toHaveBeenCalledTimes(1);
    expect(h.createStripePrice).toHaveBeenCalledWith("prod_pro", 21900, "usd", "month", 1);
    expect(h.addonUpdate).toHaveBeenCalledWith({ where: { id: "a1" }, data: { stripePriceId: "price_new" } });
    expect(h.archiveStripePrice).toHaveBeenCalledWith("price_old");
    expect(h.notify).toHaveBeenCalledWith(
      "u_admin",
      expect.objectContaining({ type: "billing", link: "/dashboard/admin/pricing" }),
    );
  });

  it("carries on past one brand's Stripe failure", async () => {
    h.addonFindMany.mockResolvedValue([
      { id: "a1", brandId: "b_one", planId: "p_pro", addonCents: 1000, stripePriceId: "" },
      { id: "a2", brandId: "b_two", planId: "p_pro", addonCents: 2000, stripePriceId: "" },
    ]);
    h.createStripePrice.mockRejectedValueOnce(new Error("boom")).mockResolvedValue("price_new");
    expect(await refreshBrandPricesForPlan("p_pro")).toEqual({ refreshed: 1, failed: 1 });
  });
});

describe("applyBrandPriceToSubscribers", () => {
  const subscriber = (id: string, subId: string) => ({
    userId: id,
    stripeSubscriptionId: subId,
    user: { email: `${id}@acme.test` },
  });

  it("moves live subscribers onto the brand's Price, skipping the ones it can't", async () => {
    h.addonFindUnique.mockResolvedValue({ addonCents: 2000, stripePriceId: "price_acme_pro" });
    h.profileFindMany.mockResolvedValue([
      subscriber("u1", "sub_1"),
      subscriber("u2", "sub_2"),
      subscriber("u3", "sub_3"),
      subscriber("u4", "sub_4"),
    ]);
    h.getSubscription.mockImplementation(async (subId: string) => {
      if (subId === "sub_1") return { status: "active", priceId: "price_base_pro", scheduleId: null };
      if (subId === "sub_2") return { status: "active", priceId: "price_acme_pro", scheduleId: null };
      if (subId === "sub_3") return { status: "active", priceId: "price_base_pro", scheduleId: "sched_1" };
      throw new Error("No such subscription");
    });

    const out = await applyBrandPriceToSubscribers({ brandId: "b_acme", planId: "p_pro", actor });

    expect(out.priceId).toBe("price_acme_pro");
    expect(out.moved).toBe(1);
    expect(out.alreadyOn).toBe(1);
    expect(out.skipped).toEqual([
      { email: "u3@acme.test", reason: "has a scheduled plan change" },
      { email: "u4@acme.test", reason: "No such subscription" },
    ]);
    expect(h.swapSubscriptionPriceNow).toHaveBeenCalledTimes(1);
    expect(h.swapSubscriptionPriceNow).toHaveBeenCalledWith("sub_1", "price_acme_pro");
  });

  it("moves subscribers back to the platform's Price when the addon was cleared", async () => {
    h.addonFindUnique.mockResolvedValue({ addonCents: 0, stripePriceId: "" });
    h.profileFindMany.mockResolvedValue([subscriber("u1", "sub_1")]);
    h.getSubscription.mockResolvedValue({ status: "active", priceId: "price_acme_pro", scheduleId: null });
    const out = await applyBrandPriceToSubscribers({ brandId: "b_acme", planId: "p_pro", actor });
    expect(out.priceId).toBe("price_base_pro");
    expect(h.swapSubscriptionPriceNow).toHaveBeenCalledWith("sub_1", "price_base_pro");
  });

  it("refuses a plan with no Stripe Price at all", async () => {
    h.planFindUnique.mockResolvedValue({ ...pro, stripePriceId: null });
    await expect(
      applyBrandPriceToSubscribers({ brandId: "b_acme", planId: "p_pro", actor }),
    ).rejects.toThrow(/isn't linked to Stripe/);
  });
});
