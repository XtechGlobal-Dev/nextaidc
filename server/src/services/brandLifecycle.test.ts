import { describe, it, expect, vi, beforeEach } from "vitest";

// Customer → Brand Admin → customer. The account, its database and its row never change: approval and downgrade
// only move the row's kind, its door and the owner's role. These pin the moves and their guards.

const h = vi.hoisted(() => ({
  rows: new Map<string, Record<string, unknown>>(),
  requests: [] as Record<string, unknown>[],
  userUpdate: vi.fn(async (_a: { where: { id: string }; data: { role: string } }) => ({})),
  updateBrand: vi.fn(async (id: string, input: Record<string, unknown>) => {
    const row = { ...h.rows.get(id)!, ...input } as Record<string, unknown>;
    if (input.customDomain) {
      row.domainStatus = "pending";
      row.customDomain = input.customDomain;
    }
    h.rows.set(id, row);
    return row;
  }),
  attach: vi.fn(async () => ({ ok: true, message: "" })),
  detach: vi.fn(async () => undefined),
  sendTemplate: vi.fn(async (..._a: unknown[]) => true),
  notify: vi.fn(async (..._a: unknown[]) => undefined),
  reqUpdate: vi.fn(async (a: { where: { id: string }; data: Record<string, unknown> }) => ({ id: a.where.id, ...a.data })),
}));

vi.mock("../prisma.js", () => ({
  prisma: {
    brand: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => h.rows.get(where.id) ?? null),
      updateMany: vi.fn(async ({ where, data }: { where: { id: string; kind: string }; data: Record<string, unknown> }) => {
        const row = h.rows.get(where.id);
        if (!row || row.kind !== where.kind) return { count: 0 };
        h.rows.set(where.id, { ...row, ...data });
        return { count: 1 };
      }),
      update: vi.fn(async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        h.rows.set(where.id, { ...h.rows.get(where.id)!, ...data });
        return h.rows.get(where.id);
      }),
    },
    brandRequest: {
      findFirst: vi.fn(async () => h.requests[0] ?? null),
      update: h.reqUpdate,
    },
    customerDirectory: {
      findUnique: vi.fn(async () => ({ email: "jo@acme.com", fullName: "Jo" })),
    },
  },
}));
vi.mock("./brands.js", () => ({
  brandOrigin: (b: { kind: string; customDomain?: string | null; slug: string }) =>
    b.kind === "customer" ? null : b.customDomain ? `https://${b.customDomain}` : `https://${b.slug}.example.com`,
  cachedBrand: (id: string) => h.rows.get(id) ?? null,
  isCustomerBrand: (b: { kind?: string } | null) => b?.kind === "customer",
  refreshBrand: async (id: string) => h.rows.get(id) ?? null,
  updateBrand: h.updateBrand,
}));
vi.mock("./tenantDb.js", () => ({ tenantFor: async () => ({ user: { update: h.userUpdate } }) }));
vi.mock("./brandDomains.js", () => ({
  attachDomainToEdge: h.attach,
  detachDomainFromEdge: h.detach,
  domainInstructions: () => [{ type: "TXT", fqdn: "_verify.app.acme.com", value: "token" }],
}));
vi.mock("./email.js", () => ({ sendTemplate: h.sendTemplate }));
vi.mock("./notifications.js", () => ({ notify: h.notify }));
vi.mock("./audit.js", () => ({ audit: vi.fn(async () => undefined) }));
vi.mock("../env.js", () => ({ appBaseUrl: "https://platform.example.com" }));

import {
  approveAdminRequest,
  downgradeToCustomer,
  promoteIfDomainLive,
  promoteToBrand,
} from "./brandLifecycle.js";

const customerRow = (over: Record<string, unknown> = {}) => ({
  id: "b1",
  kind: "customer",
  status: "active",
  slug: "c-0123456789ab",
  name: "Jo's Plumbing",
  ownerUserId: "owner",
  customDomain: null,
  domainStatus: "none",
  ...over,
});

const request = (over: Record<string, unknown> = {}) =>
  ({
    id: "r1",
    status: "approving",
    applicantBrandId: "b1",
    applicantUserId: "owner",
    slug: "acme",
    customDomain: "",
    reviewedAt: null,
    ...over,
  }) as never;

beforeEach(() => {
  vi.clearAllMocks();
  h.rows.clear();
  h.requests = [];
});

describe("approveAdminRequest", () => {
  it("with no domain of their own: the same row becomes the brand now, and its owner the Brand Admin", async () => {
    h.rows.set("b1", customerRow());
    h.requests = [{ id: "r1", status: "approving", reviewedAt: null }];
    const out = await approveAdminRequest(request(), { name: "Acme", slug: "acme" }, "super");
    expect(out.state).toBe("brand");
    expect(h.rows.get("b1")).toMatchObject({ kind: "brand", slug: "acme" });
    expect(h.userUpdate).toHaveBeenCalledWith({ where: { id: "owner" }, data: { role: "ADMIN" } });
    expect(h.reqUpdate.mock.calls.at(-1)![0].data).toMatchObject({ status: "approved", brandId: "b1" });
    expect(h.sendTemplate).toHaveBeenCalledWith(
      "brand_request_approved",
      "jo@acme.com",
      expect.objectContaining({ brand_url: "https://acme.example.com/login" }),
    );
  });

  it("with their own domain: waits for it — still a customer on the main domain until it's live", async () => {
    h.rows.set("b1", customerRow());
    const out = await approveAdminRequest(request({ customDomain: "app.acme.com" }), { name: "Acme", slug: "acme" }, "super");
    expect(out.state).toBe("awaiting_domain");
    expect(h.rows.get("b1")!.kind).toBe("customer");
    expect(h.userUpdate).not.toHaveBeenCalled();
    expect(h.attach).toHaveBeenCalledWith("app.acme.com");
    expect(h.reqUpdate.mock.calls[0][0].data).toMatchObject({ status: "awaiting_domain" });
    expect(h.sendTemplate).toHaveBeenCalledWith("brand_request_domain_pending", "jo@acme.com", expect.any(Object));
  });

  it("never touches a row that isn't the applicant's customer account", async () => {
    h.rows.set("b1", customerRow({ ownerUserId: "someone-else" }));
    await expect(approveAdminRequest(request(), { name: "Acme" }, "super")).rejects.toThrow(/changed/);
    expect(h.updateBrand).not.toHaveBeenCalled();
  });

  it("refuses a suspended account", async () => {
    h.rows.set("b1", customerRow({ status: "suspended" }));
    await expect(approveAdminRequest(request(), { name: "Acme" }, "super")).rejects.toThrow(/suspended/);
  });
});

describe("promoteIfDomainLive", () => {
  it("promotes once the waited-for domain verifies", async () => {
    h.rows.set("b1", customerRow({ customDomain: "app.acme.com", domainStatus: "verified" }));
    h.requests = [{ id: "r1", status: "awaiting_domain", reviewedById: "super" }];
    const brand = await promoteIfDomainLive("b1");
    expect(brand?.kind).toBe("brand");
    expect(h.userUpdate).toHaveBeenCalledWith({ where: { id: "owner" }, data: { role: "ADMIN" } });
  });

  it("does nothing while the domain is still pending", async () => {
    h.rows.set("b1", customerRow({ customDomain: "app.acme.com", domainStatus: "pending" }));
    expect(await promoteIfDomainLive("b1")).toBeNull();
  });
});

describe("promoteToBrand", () => {
  it("is idempotent — a second call changes nothing", async () => {
    h.rows.set("b1", customerRow());
    await promoteToBrand("b1");
    vi.clearAllMocks();
    await promoteToBrand("b1");
    expect(h.userUpdate).not.toHaveBeenCalled();
    expect(h.sendTemplate).not.toHaveBeenCalled();
  });
});

describe("downgradeToCustomer", () => {
  it("closes the door, hands the domain back and makes the owner a customer — deleting nothing", async () => {
    h.rows.set(
      "b1",
      customerRow({ kind: "brand", slug: "acme", customDomain: "app.acme.com", domainStatus: "verified" }),
    );
    const brand = await downgradeToCustomer("b1", { reason: "no_active_customers" });
    expect(brand).toMatchObject({ kind: "customer", customDomain: null, domainStatus: "none" });
    expect(brand.slug).toMatch(/^c-[0-9a-f]{12}$/);
    expect(h.detach).toHaveBeenCalledWith("app.acme.com");
    expect(h.userUpdate).toHaveBeenCalledWith({ where: { id: "owner" }, data: { role: "USER" } });
    expect(h.sendTemplate).toHaveBeenCalledWith(
      "brand_admin_downgraded",
      "jo@acme.com",
      expect.objectContaining({ login_url: "https://platform.example.com/login" }),
    );
  });

  it("takes a deactivated brand off its deletion countdown — the customer account it becomes is kept", async () => {
    h.rows.set("b1", customerRow({ kind: "brand", slug: "acme", status: "deactivated", deactivatedAt: new Date() }));
    const brand = await downgradeToCustomer("b1", { reason: "super_admin" });
    expect(brand).toMatchObject({ kind: "customer", status: "active", deactivatedAt: null });
  });

  it("refuses a brand with no owner on record (it has no account to fall back to)", async () => {
    h.rows.set("b1", customerRow({ kind: "brand", ownerUserId: null }));
    await expect(downgradeToCustomer("b1", { reason: "x" })).rejects.toThrow(/no owner/);
  });

  it("is a no-op for a row that is already a customer", async () => {
    h.rows.set("b1", customerRow());
    await downgradeToCustomer("b1", { reason: "x" });
    expect(h.userUpdate).not.toHaveBeenCalled();
  });
});
