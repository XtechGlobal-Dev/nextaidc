import { describe, it, expect, vi, beforeEach } from "vitest";

// Main-domain customers (docs/brand-as-customer-plan.md): each sign-up gets its own customer-state brand row
// and database. Only the row's OWNER is the main-domain customer — a downgraded brand's own customers live
// in that database too and must not slip in through the platform door.

const h = vi.hoisted(() => ({
  brandFindUnique: vi.fn(),
  brandFindMany: vi.fn(),
  brandCreate: vi.fn(),
  brandUpdate: vi.fn(async () => ({})),
  brandUpdateMany: vi.fn(async (_args: { where: unknown; data: unknown }) => ({ count: 1 })),
  dirFindMany: vi.fn(),
  loadBrands: vi.fn(async () => undefined),
  provisionBrand: vi.fn(),
  cachedBrand: vi.fn((_id: string): { activatedAt: Date | null } | null => null),
  profileFindFirst: vi.fn(),
  planEventCount: vi.fn(async () => 0),
  destroyBrand: vi.fn(async (): Promise<void> => undefined),
  audit: vi.fn(async (): Promise<void> => undefined),
  claimSpare: vi.fn(async (_slug: string, _name: string): Promise<Record<string, unknown> | null> => null),
}));

vi.mock("../prisma.js", () => ({
  prisma: {
    brand: {
      findUnique: h.brandFindUnique,
      findMany: h.brandFindMany,
      create: h.brandCreate,
      update: h.brandUpdate,
      updateMany: h.brandUpdateMany,
    },
    customerDirectory: { findMany: h.dirFindMany },
  },
}));
vi.mock("./brands.js", () => ({
  cachedBrand: h.cachedBrand,
  refreshBrand: h.loadBrands,
  provisionBrand: h.provisionBrand,
}));
vi.mock("./tenantDb.js", () => ({
  tenantFor: async () => ({
    profile: { findFirst: h.profileFindFirst },
    planEvent: { count: h.planEventCount },
  }),
}));
vi.mock("./brandDeactivation.js", () => ({ destroyBrand: h.destroyBrand }));
vi.mock("./audit.js", () => ({ audit: h.audit }));
vi.mock("./customerPool.js", () => ({ claimSpare: h.claimSpare }));

import {
  customerBrandFor,
  customerSlugFor,
  emailOwnsAccount,
  findPlatformCustomer,
  markBrandActivated,
  newAccountId,
  platformAccountFor,
  runAbandonedSignupSweep,
} from "./platformCustomers.js";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("customerSlugFor", () => {
  it("is stable per email, ignoring case and spaces, so a retry finds the same row", () => {
    expect(customerSlugFor(" Jo@Example.com ")).toBe(customerSlugFor("jo@example.com"));
    expect(customerSlugFor("jo@example.com")).toMatch(/^c-[0-9a-f]{12}$/);
    expect(customerSlugFor("a@example.com")).not.toBe(customerSlugFor("b@example.com"));
  });
});

describe("findPlatformCustomer", () => {
  it("finds the owner of a customer-state row", async () => {
    h.dirFindMany.mockResolvedValue([{ brandId: "b1", userId: "u1", brand: { ownerUserId: "u1" } }]);
    expect(await findPlatformCustomer("jo@example.com")).toEqual({ brandId: "b1", userId: "u1", ownerSet: true });
    expect(h.dirFindMany.mock.calls[0][0].where).toEqual({ email: "jo@example.com", brand: { kind: "customer" } });
  });

  it("ignores a downgraded brand's own customers", async () => {
    h.dirFindMany.mockResolvedValue([{ brandId: "b1", userId: "u2", brand: { ownerUserId: "u1" } }]);
    expect(await findPlatformCustomer("jo@example.com")).toBeNull();
  });

  it("still finds an interrupted sign-up whose owner was never stamped", async () => {
    h.dirFindMany.mockResolvedValue([{ brandId: "b1", userId: "u1", brand: { ownerUserId: null } }]);
    expect(await findPlatformCustomer("jo@example.com")).toEqual({ brandId: "b1", userId: "u1", ownerSet: false });
  });
});

describe("emailOwnsAccount", () => {
  it("is true for a brand's owner, who signs in on their brand's door", async () => {
    h.dirFindMany.mockResolvedValue([{ userId: "u1", brand: { kind: "brand", ownerUserId: "u1" } }]);
    expect(await emailOwnsAccount("jo@example.com")).toBe(true);
  });

  it("is false for someone who is only another brand's customer", async () => {
    h.dirFindMany.mockResolvedValue([{ userId: "u9", brand: { kind: "brand", ownerUserId: "u1" } }]);
    expect(await emailOwnsAccount("jo@example.com")).toBe(false);
  });
});

describe("platformAccountFor", () => {
  it("answers both sign-up questions from one read", async () => {
    h.dirFindMany.mockResolvedValue([
      { brandId: "b1", userId: "u1", brand: { kind: "customer", ownerUserId: "u1" } },
      { brandId: "b2", userId: "u9", brand: { kind: "brand", ownerUserId: "x" } },
    ]);
    expect(await platformAccountFor("jo@example.com")).toEqual({
      mine: { brandId: "b1", userId: "u1", ownerSet: true },
      ownsAccount: true,
    });
    expect(h.dirFindMany).toHaveBeenCalledTimes(1);
  });

  it("is a brand's owner — owns an account, but has no main-domain one", async () => {
    h.dirFindMany.mockResolvedValue([{ brandId: "b2", userId: "u1", brand: { kind: "brand", ownerUserId: "u1" } }]);
    expect(await platformAccountFor("jo@example.com")).toEqual({ mine: null, ownsAccount: true });
  });
});

describe("newAccountId", () => {
  it("looks like the ids the database mints, and never repeats", () => {
    const ids = new Set(Array.from({ length: 500 }, newAccountId));
    expect(ids.size).toBe(500);
    for (const id of ids) expect(id).toMatch(/^c[0-9a-z]{24}$/);
  });
});

describe("customerBrandFor", () => {
  it("creates a customer-state row and provisions its database", async () => {
    h.brandFindUnique.mockResolvedValue(null);
    h.brandCreate.mockImplementation(async ({ data }) => ({ id: "b1", ...data }));
    h.provisionBrand.mockResolvedValue({ id: "b1", kind: "customer", status: "active" });
    const brand = await customerBrandFor("jo@example.com", "Jo's Plumbing");
    const data = h.brandCreate.mock.calls[0][0].data;
    expect(data).toMatchObject({ kind: "customer", status: "provisioning", name: "Jo's Plumbing" });
    expect(data.slug).toBe(customerSlugFor("jo@example.com"));
    expect(h.provisionBrand).toHaveBeenCalledWith("b1");
    expect(brand.status).toBe("active");
  });

  it("claims a ready spare first — no database to wait for", async () => {
    h.brandFindUnique.mockResolvedValue(null);
    h.claimSpare.mockResolvedValueOnce({ id: "spare1", kind: "customer", status: "active" });
    const brand = await customerBrandFor("jo@example.com", "Jo's Plumbing");
    expect(h.claimSpare).toHaveBeenCalledWith(customerSlugFor("jo@example.com"), "Jo's Plumbing", undefined);
    expect(h.brandCreate).not.toHaveBeenCalled();
    expect(h.provisionBrand).not.toHaveBeenCalled();
    expect(brand.id).toBe("spare1");
  });

  it("retries a failed database instead of making a second one", async () => {
    h.brandFindUnique.mockResolvedValue({ id: "b1", kind: "customer", status: "failed" });
    h.provisionBrand.mockResolvedValue({ id: "b1", kind: "customer", status: "active" });
    await customerBrandFor("jo@example.com", "Jo");
    expect(h.brandCreate).not.toHaveBeenCalled();
    expect(h.provisionBrand).toHaveBeenCalledWith("b1");
  });

  it("says try again while the database is still being set up", async () => {
    h.brandFindUnique.mockResolvedValue({ id: "b1", kind: "customer", status: "provisioning", updatedAt: new Date() });
    await expect(customerBrandFor("jo@example.com", "Jo")).rejects.toMatchObject({ status: 503 });
    expect(h.provisionBrand).not.toHaveBeenCalled();
  });

  it("re-runs a setup abandoned by a restart instead of saying try again for ever", async () => {
    h.brandFindUnique.mockResolvedValue({
      id: "b1",
      kind: "customer",
      status: "provisioning",
      updatedAt: new Date(Date.now() - 60 * 60 * 1000),
    });
    h.provisionBrand.mockResolvedValue({ id: "b1", kind: "customer", status: "active" });
    expect((await customerBrandFor("jo@example.com", "Jo")).status).toBe("active");
    expect(h.provisionBrand).toHaveBeenCalledWith("b1");
  });

  it("never takes over a row that is a brand", async () => {
    h.brandFindUnique.mockResolvedValue({ id: "b1", kind: "brand", status: "active" });
    await expect(customerBrandFor("jo@example.com", "Jo")).rejects.toMatchObject({ status: 409 });
  });
});

describe("markBrandActivated", () => {
  it("stamps once and skips a row the cache already shows as activated", async () => {
    await markBrandActivated("b1");
    expect(h.brandUpdateMany.mock.calls[0][0].where).toEqual({ id: "b1", activatedAt: null });
    h.cachedBrand.mockReturnValueOnce({ activatedAt: new Date() });
    await markBrandActivated("b1");
    expect(h.brandUpdateMany).toHaveBeenCalledTimes(1);
  });
});

describe("runAbandonedSignupSweep", () => {
  const row = { id: "b1", slug: "c-1", name: "Jo", customDomain: null, status: "active", ownerUserId: "u1", createdAt: new Date() };

  it("only looks at never-activated customer rows older than 30 days", async () => {
    h.brandFindMany.mockResolvedValue([]);
    const now = new Date("2026-10-31T00:00:00Z");
    await runAbandonedSignupSweep(now);
    const where = h.brandFindMany.mock.calls[0][0].where;
    expect(where).toMatchObject({ kind: "customer", poolSpare: false, activatedAt: null, brandSince: null });
    expect(where.createdAt.lte.toISOString()).toBe("2026-10-01T00:00:00.000Z");
  });

  it("deletes a sign-up that never started a plan or trial", async () => {
    h.brandFindMany.mockResolvedValue([row]);
    h.profileFindFirst.mockResolvedValue({ subscriptionStatus: "none", trialStartedAt: null });
    const out = await runAbandonedSignupSweep();
    expect(h.destroyBrand).toHaveBeenCalledWith(row);
    expect(out.deleted).toEqual(["c-1"]);
  });

  it("keeps (and stamps) one that started a trial", async () => {
    h.brandFindMany.mockResolvedValue([row]);
    h.profileFindFirst.mockResolvedValue({ subscriptionStatus: "none", trialStartedAt: new Date() });
    const out = await runAbandonedSignupSweep();
    expect(h.destroyBrand).not.toHaveBeenCalled();
    expect(h.brandUpdateMany).toHaveBeenCalled();
    expect(out.kept).toEqual(["c-1"]);
  });

  it("keeps one with plan history even if it is cancelled now", async () => {
    h.brandFindMany.mockResolvedValue([row]);
    h.profileFindFirst.mockResolvedValue({ subscriptionStatus: "none", trialStartedAt: null });
    h.planEventCount.mockResolvedValueOnce(2);
    await runAbandonedSignupSweep();
    expect(h.destroyBrand).not.toHaveBeenCalled();
  });

  it("deletes a row whose database never came up", async () => {
    h.brandFindMany.mockResolvedValue([{ ...row, status: "failed" }]);
    await runAbandonedSignupSweep();
    expect(h.profileFindFirst).not.toHaveBeenCalled();
    expect(h.destroyBrand).toHaveBeenCalled();
  });
});
