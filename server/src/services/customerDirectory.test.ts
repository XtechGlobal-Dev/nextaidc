import { describe, it, expect, vi, beforeEach } from "vitest";

/* ------------------------------------------------------------------ *
 *  The thin customer directory: brand, id, email, name, role — kept in
 *  Main so "which brand is this email in?" and "how many people does
 *  this brand have?" are answered without opening a tenant. Writes are
 *  best-effort; the rebuild is exact.
 * ------------------------------------------------------------------ */

const h = vi.hoisted(() => ({
  upsert: vi.fn(async (_args?: unknown) => ({}) as unknown),
  deleteMany: vi.fn(async (_args?: unknown) => ({ count: 1 })),
  findMany: vi.fn(async (_args?: unknown) => [] as unknown[]),
  groupBy: vi.fn(async (_args?: unknown) => [] as unknown[]),
}));

vi.mock("../prisma.js", () => {
  const directory = { upsert: h.upsert, deleteMany: h.deleteMany, findMany: h.findMany, groupBy: h.groupBy };
  return {
    prisma: {
      customerDirectory: directory,
      $transaction: async (fn: (tx: { customerDirectory: typeof directory }) => Promise<unknown>) =>
        fn({ customerDirectory: directory }),
    },
  };
});

const { rememberInDirectory, forgetInDirectory, rebuildDirectory, searchDirectory, directoryCounts } =
  await import("./customerDirectory.js");

const person = (id: string, role = "USER") => ({
  id,
  email: `${id}@example.com`,
  fullName: id.toUpperCase(),
  role,
  createdAt: new Date("2026-09-01T00:00:00Z"),
});

beforeEach(() => {
  vi.clearAllMocks();
});

describe("keeping the directory in step", () => {
  it("remembers an account under its brand, keyed by brand + id", async () => {
    await rememberInDirectory("b_acme", person("u1"));
    expect(h.upsert).toHaveBeenCalledWith({
      where: { brandId_userId: { brandId: "b_acme", userId: "u1" } },
      create: expect.objectContaining({ brandId: "b_acme", userId: "u1", email: "u1@example.com", fullName: "U1", role: "USER" }),
      update: expect.objectContaining({ email: "u1@example.com", fullName: "U1" }),
    });
  });

  it("forgets an account that left the brand", async () => {
    await forgetInDirectory("b_acme", "u1");
    expect(h.deleteMany).toHaveBeenCalledWith({ where: { brandId: "b_acme", userId: "u1" } });
  });

  it("never fails the account write when the directory write does", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    h.upsert.mockRejectedValueOnce(new Error("db down"));
    await expect(rememberInDirectory("b_acme", person("u1"))).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("rebuilds a brand's directory to exactly the people given: strangers out, everyone else upserted", async () => {
    const n = await rebuildDirectory("b_acme", [person("u1"), person("u2", "ADMIN")]);
    expect(n).toBe(2);
    expect(h.deleteMany).toHaveBeenCalledWith({ where: { brandId: "b_acme", userId: { notIn: ["u1", "u2"] } } });
    expect(h.upsert).toHaveBeenCalledTimes(2);
    expect(h.upsert.mock.calls[1][0]).toMatchObject({ where: { brandId_userId: { brandId: "b_acme", userId: "u2" } } });
  });
});

describe("finding a person anywhere", () => {
  it("asks nothing for a blank search", async () => {
    expect(await searchDirectory("   ")).toEqual([]);
    expect(h.findMany).not.toHaveBeenCalled();
  });

  it("matches email or name, case-insensitively, and says which brand each hit is in", async () => {
    h.findMany.mockResolvedValueOnce([
      {
        brandId: "b_acme",
        userId: "u1",
        email: "u1@example.com",
        fullName: "U1",
        role: "USER",
        createdAt: new Date(0),
        brand: { id: "b_acme", name: "Acme", slug: "acme", status: "active" },
      },
    ]);
    const hits = await searchDirectory("U1");
    expect(h.findMany.mock.calls[0][0]).toMatchObject({
      where: {
        OR: [
          { email: { contains: "U1", mode: "insensitive" } },
          { fullName: { contains: "U1", mode: "insensitive" } },
        ],
      },
      take: 25,
    });
    expect(hits).toEqual([
      expect.objectContaining({ brandId: "b_acme", userId: "u1", brand: expect.objectContaining({ name: "Acme" }) }),
    ]);
  });
});

describe("counting a brand's people", () => {
  it("splits admins from customers and zero-fills brands with nobody", async () => {
    h.groupBy.mockResolvedValueOnce([
      { brandId: "b_acme", role: "USER", _count: { _all: 12 } },
      { brandId: "b_acme", role: "ADMIN", _count: { _all: 1 } },
      { brandId: "b_acme", role: "STAFF", _count: { _all: 2 } },
      { brandId: "b_acme", role: "RESELLER", _count: { _all: 1 } },
    ]);
    const counts = await directoryCounts(["b_acme", "b_empty"]);
    expect(counts.get("b_acme")).toEqual({ admins: 3, customers: 13, total: 16 });
    expect(counts.get("b_empty")).toEqual({ admins: 0, customers: 0, total: 0 });
  });

  it("asks nothing for no brands", async () => {
    expect((await directoryCounts([])).size).toBe(0);
    expect(h.groupBy).not.toHaveBeenCalled();
  });
});
