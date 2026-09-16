import { describe, it, expect, vi, beforeEach } from "vitest";

// Deactivate = off now, deleted 30 days on; reactivate cancels; delete = gone now. The sweep is the
// only thing that turns a countdown into a deletion, and one failure must not stall the rest.

const h = vi.hoisted(() => ({
  findUnique: vi.fn(),
  findMany: vi.fn(),
  update: vi.fn(async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => ({
    id: where.id,
    slug: "acme",
    name: "Acme",
    customDomain: null,
    ...data,
  })),
  deleteBrand: vi.fn(async (_id: string): Promise<void> => undefined),
  loadBrands: vi.fn(async () => undefined),
  detach: vi.fn(async (_domain: string): Promise<void> => undefined),
  audit: vi.fn(
    async (_e: { action: string; actorEmail?: string; targetId?: string; metadata?: unknown }): Promise<void> =>
      undefined,
  ),
}));

vi.mock("../prisma.js", () => ({
  prisma: { brand: { findUnique: h.findUnique, findMany: h.findMany, update: h.update } },
}));
vi.mock("./brands.js", () => ({
  BRAND_DEACTIVATION_DAYS: 30,
  deleteBrand: h.deleteBrand,
  loadBrands: h.loadBrands,
}));
vi.mock("./brandDomains.js", () => ({ detachDomainFromEdge: h.detach }));
vi.mock("./audit.js", () => ({ audit: h.audit }));

import {
  deactivateBrand,
  destroyBrand,
  reactivateBrand,
  runBrandDeactivationSweep,
} from "./brandDeactivation.js";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("deactivateBrand", () => {
  it("switches an active brand off and starts the clock", async () => {
    h.findUnique.mockResolvedValue({ id: "b1", status: "active" });
    const before = Date.now();
    const brand = await deactivateBrand("b1");
    const data = h.update.mock.calls[0][0].data;
    expect(data.status).toBe("deactivated");
    expect((data.deactivatedAt as Date).getTime()).toBeGreaterThanOrEqual(before);
    expect(brand.status).toBe("deactivated");
    expect(h.loadBrands).toHaveBeenCalled();
  });

  it("takes a suspended brand too", async () => {
    h.findUnique.mockResolvedValue({ id: "b1", status: "suspended" });
    await deactivateBrand("b1");
    expect(h.update).toHaveBeenCalled();
  });

  it("refuses a brand still in setup — Retry or Delete are its only doors", async () => {
    h.findUnique.mockResolvedValue({ id: "b1", status: "provisioning" });
    await expect(deactivateBrand("b1")).rejects.toThrow(/isn't ready/);
    expect(h.update).not.toHaveBeenCalled();
  });

  it("refuses a second deactivation, so the clock is never restarted", async () => {
    h.findUnique.mockResolvedValue({ id: "b1", status: "deactivated" });
    await expect(deactivateBrand("b1")).rejects.toThrow(/already deactivated/);
    expect(h.update).not.toHaveBeenCalled();
  });

  it("404s an unknown brand", async () => {
    h.findUnique.mockResolvedValue(null);
    await expect(deactivateBrand("nope")).rejects.toThrow(/not found/i);
  });
});

describe("reactivateBrand", () => {
  it("clears the clock and puts the brand back online", async () => {
    h.findUnique.mockResolvedValue({ id: "b1", status: "deactivated" });
    const brand = await reactivateBrand("b1");
    expect(h.update.mock.calls[0][0].data).toEqual({ status: "active", deactivatedAt: null });
    expect(brand.status).toBe("active");
    expect(h.loadBrands).toHaveBeenCalled();
  });

  it("refuses a brand that isn't deactivated", async () => {
    h.findUnique.mockResolvedValue({ id: "b1", status: "suspended" });
    await expect(reactivateBrand("b1")).rejects.toThrow(/isn't deactivated/);
    expect(h.update).not.toHaveBeenCalled();
  });
});

describe("destroyBrand", () => {
  it("hands a custom domain back to the edge before the row goes", async () => {
    const order: string[] = [];
    h.detach.mockImplementation(async () => {
      order.push("detach");
    });
    h.deleteBrand.mockImplementation(async () => {
      order.push("delete");
    });
    await destroyBrand({ id: "b1", customDomain: "voice.acme.com" });
    expect(h.detach).toHaveBeenCalledWith("voice.acme.com");
    expect(order).toEqual(["detach", "delete"]);
  });

  it("skips the edge when there is no custom domain", async () => {
    await destroyBrand({ id: "b1", customDomain: null });
    expect(h.detach).not.toHaveBeenCalled();
    expect(h.deleteBrand).toHaveBeenCalledWith("b1");
  });
});

describe("runBrandDeactivationSweep", () => {
  it("asks only for brands whose 30 days are up", async () => {
    h.findMany.mockResolvedValue([]);
    const { deleted } = await runBrandDeactivationSweep(new Date("2026-10-01T00:00:00Z"));
    expect(deleted).toEqual([]);
    const where = h.findMany.mock.calls[0][0].where;
    expect(where.status).toBe("deactivated");
    expect(where.deactivatedAt.lte.toISOString()).toBe("2026-09-01T00:00:00.000Z");
  });

  it("deletes each due brand independently and records that the system did it", async () => {
    h.findMany.mockResolvedValue([
      { id: "b1", slug: "acme", name: "Acme", customDomain: null, deactivatedAt: new Date("2026-08-01") },
      { id: "b2", slug: "globex", name: "Globex", customDomain: null, deactivatedAt: new Date("2026-08-02") },
      { id: "b3", slug: "initech", name: "Initech", customDomain: null, deactivatedAt: new Date("2026-08-03") },
    ]);
    h.deleteBrand.mockImplementation(async (id: string) => {
      if (id === "b2") throw new Error("Neon is down");
    });
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    const { deleted } = await runBrandDeactivationSweep();

    expect(deleted).toEqual(["acme", "initech"]);
    expect(h.audit.mock.calls.map((c) => c[0].targetId)).toEqual(["b1", "b3"]);
    expect(h.audit.mock.calls[0][0]).toMatchObject({
      action: "brand.delete",
      actorEmail: "system",
      metadata: { reason: "deactivation_expired" },
    });
    err.mockRestore();
    log.mockRestore();
  });
});
