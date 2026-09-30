import { describe, it, expect, vi } from "vitest";

// A brand plan becomes a brand's billing: its price the fee, its features included, every other module an
// add-on at the add-on list's price — or off, when the list doesn't offer it.

vi.mock("../prisma.js", () => ({ prisma: {} }));
vi.mock("./brands.js", () => ({ loadBrands: async () => undefined }));
vi.mock("./brandBilling.js", () => ({ syncBrandSubscription: async () => undefined }));
vi.mock("./brandUsage.js", () => ({ ensureBillingRow: async () => undefined }));

import { planConfig, planFeatures } from "./brandPlanCatalog.js";

const plan = {
  priceCents: 5000,
  currency: "usd",
  features: ["booking", "transfer", "nope"],
  monthlyMinuteLimit: 2000,
  monthlyAiLimit: null,
};

describe("planConfig", () => {
  it("turns a plan into the brand's fee, access, add-on prices and caps", () => {
    const addons = new Map([
      ["crm", { priceCents: 1500, active: true }],
      ["whatsapp", { priceCents: 900, active: false }],
    ]);
    const config = planConfig(plan, addons);
    expect(config.platformFeeCents).toBe(5000);
    expect(config.platformFeeCurrency).toBe("usd");
    expect(config.monthlyMinuteLimit).toBe(2000);
    expect(config.monthlyAiLimit).toBeNull();
    // Included: on, no price. Offered add-on: on, priced. Not offered: off.
    expect(config.modules).toEqual({ booking: true, transfer: true, crm: true, smsToCaller: false, whatsapp: false });
    expect(config.featurePrices).toEqual({ crm: 1500 });
  });

  it("never charges for what the plan already includes, even if the add-on list prices it", () => {
    const config = planConfig(plan, new Map([["booking", { priceCents: 700, active: true }]]));
    expect(config.featurePrices).toEqual({});
    expect(config.modules.booking).toBe(true);
  });

  it("ignores unknown feature ids", () => {
    expect(planFeatures(plan)).toEqual(["booking", "transfer"]);
  });
});
