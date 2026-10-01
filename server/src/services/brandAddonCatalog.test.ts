import { describe, it, expect, vi, beforeEach } from "vitest";

// SMS to Caller and WhatsApp are default features now, never sold separately: they must never appear in the
// add-on list, and saving a price for one must be refused outright (not just ignored).

const h = vi.hoisted(() => ({
  addonFindMany: vi.fn(async (): Promise<{ moduleId: string; priceCents: number; active: boolean }[]> => []),
  upsert: vi.fn(),
  transaction: vi.fn(async (ops: unknown[]) => ops),
  brandFindMany: vi.fn(async (): Promise<{ id: string }[]> => []),
}));

vi.mock("../prisma.js", () => ({
  prisma: {
    brandAddonPrice: { findMany: h.addonFindMany, upsert: h.upsert },
    brand: { findMany: h.brandFindMany },
    $transaction: h.transaction,
  },
}));
vi.mock("./brands.js", () => ({ loadBrands: async () => undefined }));
vi.mock("./brandBilling.js", () => ({ syncBrandSubscription: async () => undefined }));
vi.mock("./brandUsage.js", () => ({ ensureBillingRow: async () => undefined }));

import { listAddonPrices, saveAddonPrices } from "./brandPlanCatalog.js";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("listAddonPrices", () => {
  it("never lists SMS to Caller or WhatsApp", () => {
    return listAddonPrices().then((rows) => {
      const ids = rows.map((r) => r.moduleId);
      expect(ids).not.toContain("smsToCaller");
      expect(ids).not.toContain("whatsapp");
      expect(ids).toEqual(expect.arrayContaining(["booking", "transfer", "crm"]));
    });
  });
});

describe("saveAddonPrices", () => {
  it("refuses to price a default feature as an add-on", async () => {
    await expect(saveAddonPrices([{ moduleId: "whatsapp", priceCents: 900, active: true }])).rejects.toThrow(
      /default feature/,
    );
    expect(h.upsert).not.toHaveBeenCalled();
  });

  it("saves a normal add-on-eligible module", async () => {
    await saveAddonPrices([{ moduleId: "crm", priceCents: 1500, active: true }]);
    expect(h.transaction).toHaveBeenCalled();
  });
});
