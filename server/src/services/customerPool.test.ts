import { describe, it, expect, vi, beforeEach } from "vitest";

// The spare pool: a sign-up claims a ready database with one row update; two sign-ups never get the same spare;
// the refill keeps the target, and a failing provider can't make it create databases without end.

const h = vi.hoisted(() => ({
  spares: [] as { id: string; status: string; poolSpare: boolean; updatedAt?: Date }[],
  created: 0,
  provision: vi.fn(async (id: string) => ({ id, status: "active" })),
  warm: vi.fn(async (_id: string) => ({})),
  claimSql: "",
  claimValues: [] as unknown[],
}));

vi.mock("../prisma.js", () => ({
  prisma: {
    brand: {
      findMany: vi.fn(async () => h.spares.filter((s) => s.poolSpare)),
      create: vi.fn(async () => {
        const row = { id: `new${++h.created}`, status: "provisioning", poolSpare: true, updatedAt: new Date() };
        h.spares.push(row);
        return row;
      }),
    },
    // The claim is one UPDATE … RETURNING; the stand-in takes the oldest ready spare, as the SQL does.
    $queryRaw: vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
      h.claimSql = strings.join("?");
      h.claimValues = values;
      const s = h.spares.find((x) => x.poolSpare && x.status === "active");
      if (!s) return [];
      s.poolSpare = false;
      return [{ ...s, slug: values[0], name: values[1], ownerUserId: values[2] }];
    }),
  },
}));
vi.mock("./brands.js", () => ({ provisionBrand: h.provision, cacheBrandRow: (row: unknown) => row }));
vi.mock("./tenantDb.js", () => ({ tenantFor: h.warm }));

import { claimSpare, poolTarget, refillCustomerPool } from "./customerPool.js";

beforeEach(() => {
  vi.clearAllMocks();
  h.spares = [];
  h.created = 0;
  process.env.CUSTOMER_DB_POOL_SIZE = "2";
});

describe("claimSpare", () => {
  it("claims a ready spare in one statement — renamed, owner named, clock restarted", async () => {
    h.spares = [{ id: "s1", status: "active", poolSpare: true }];
    const brand = (await claimSpare("c-abc", "Jo's Plumbing", "cOwner")) as unknown as Record<string, unknown>;
    expect(brand).toMatchObject({ id: "s1", slug: "c-abc", name: "Jo's Plumbing", ownerUserId: "cOwner" });
    expect(h.claimValues).toEqual(["c-abc", "Jo's Plumbing", "cOwner"]);
    expect(h.claimSql).toMatch(/"createdAt" = now\(\)/);
    // Two racing sign-ups never share a spare: the row is locked and skipped by the other.
    expect(h.claimSql).toMatch(/FOR UPDATE SKIP LOCKED/);
  });

  it("returns null when none is ready, so the sign-up provisions its own", async () => {
    expect(await claimSpare("c-abc", "Jo")).toBeNull();
  });
});

describe("refillCustomerPool", () => {
  it("tops up to the target, and opens every ready spare's connection ahead of its sign-up", async () => {
    h.spares = [{ id: "s1", status: "active", poolSpare: true, updatedAt: new Date() }];
    expect(await refillCustomerPool()).toBe(1);
    expect(h.provision).toHaveBeenCalledTimes(1);
    expect(h.warm).toHaveBeenCalledWith("s1");
    expect(h.warm).toHaveBeenCalledWith("new1");
  });

  it("re-runs setup for a spare abandoned mid-setup by a restart — but not one still being set up", async () => {
    const old = new Date(Date.now() - 60 * 60 * 1000);
    h.spares = [
      { id: "stuck", status: "provisioning", poolSpare: true, updatedAt: old },
      { id: "busy", status: "provisioning", poolSpare: true, updatedAt: new Date() },
    ];
    await refillCustomerPool();
    expect(h.provision).toHaveBeenCalledWith("stuck");
    expect(h.provision).not.toHaveBeenCalledWith("busy");
    expect(h.created).toBe(0);
  });

  it("stops at the first failure instead of creating databases without end", async () => {
    h.provision.mockResolvedValue({ id: "x", status: "failed" });
    expect(await refillCustomerPool()).toBe(0);
    expect(h.created).toBe(1);
  });

  it("is off at 0", async () => {
    process.env.CUSTOMER_DB_POOL_SIZE = "0";
    expect(poolTarget()).toBe(0);
    expect(await refillCustomerPool()).toBe(0);
  });
});
