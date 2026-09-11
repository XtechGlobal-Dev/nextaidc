import { describe, it, expect, vi, beforeEach } from "vitest";

/* ------------------------------------------------------------------ *
 *  Tenant routing. Getting this wrong has two failure modes and they
 *  are not equally bad:
 *
 *    - refusing a ready tenant → an error, loud, fixed in a minute;
 *    - serving a brand from the WRONG database, or from the control
 *      plane when its own database exists → its customers' rows in
 *      shared storage, or in another brand's, silently. That is the
 *      contract this module exists to keep, so the tests below are
 *      mostly about that direction.
 * ------------------------------------------------------------------ */

const h = vi.hoisted(() => ({
  findMany: vi.fn(),
  decrypt: vi.fn((s: string) => `decrypted:${s}`),
  /** What each tenant database's own tenant_info answers, keyed by URL. */
  owners: new Map<string, string | null>(),
}));

vi.mock("../prisma.js", () => ({ prisma: { __control: true, brandDatabase: { findMany: h.findMany } } }));
vi.mock("../lib/crypto.js", () => ({ decryptSecret: h.decrypt, encryptSecret: (s: string) => s }));
vi.mock("../lib/brandContext.js", () => ({ currentBrandId: () => null }));

// A real client would try to open a pool against a fake URL; the identity of
// what comes back, and what it was pointed at, is all these tests care about.
vi.mock("@prisma/tenant-client", () => ({
  PrismaClient: class {
    tenantInfo: { findUnique: () => Promise<{ brandId: string } | null> };
    constructor(public opts: { datasources: { db: { url: string } } }) {
      const url = opts.datasources.db.url;
      this.tenantInfo = {
        findUnique: async () => {
          const owner = h.owners.get(url);
          return owner ? { brandId: owner } : null;
        },
      };
    }
    $disconnect() {
      return Promise.resolve();
    }
  },
}));

const {
  tenantFor,
  tenantStatus,
  activeTenantIds,
  callDb,
  allCallDbs,
  assertRoutable,
  CrossDatabaseQueryError,
  TenantUnavailableError,
  TenantMismatchError,
  invalidateTenantRegistry,
  disconnectTenantDbs,
} = await import("./tenantDb.js");
const { prisma } = await import("../prisma.js");

function row(brandId: string, status = "active") {
  return { brandId, status, urlEncrypted: `url-${brandId}` };
}

type Opened = { opts: { datasources: { db: { url: string } } } };

beforeEach(async () => {
  vi.clearAllMocks();
  await disconnectTenantDbs();
  h.decrypt.mockImplementation((s: string) => `decrypted:${s}`);
  h.findMany.mockResolvedValue([]);
  h.owners.clear();
  // By default every tenant database correctly names its brand.
  h.owners.set("decrypted:url-b_acme", "b_acme");
  h.owners.set("decrypted:url-b_globex", "b_globex");
});

describe("tenantFor — a brand's own database", () => {
  it("opens a client on the decrypted URL for an active tenant", async () => {
    h.findMany.mockResolvedValue([row("b_acme")]);
    const db = (await tenantFor("b_acme")) as unknown as Opened;
    expect(db.opts.datasources.db.url).toBe("decrypted:url-b_acme");
  });

  it("reuses one client per brand rather than opening a pool per query", async () => {
    h.findMany.mockResolvedValue([row("b_acme")]);
    expect(await tenantFor("b_acme")).toBe(await tenantFor("b_acme"));
  });

  it("refuses a brand with no database, naming the reason", async () => {
    await expect(tenantFor("b_none")).rejects.toThrow(TenantUnavailableError);
    await expect(tenantFor("b_none")).rejects.toMatchObject({ status: "none" });
    await expect(tenantFor(null)).rejects.toThrow(TenantUnavailableError);
  });

  // Anything but `active` means the database is not ready to be trusted with
  // traffic. It is NEVER the control plane instead — that would put the
  // brand's rows in the wrong database.
  it.each(["provisioning", "migrating", "failed", "disabled"])(
    "refuses a brand whose database is %s, and never falls back",
    async (status) => {
      h.findMany.mockResolvedValue([row("b_acme", status)]);
      await expect(tenantFor("b_acme")).rejects.toMatchObject({ brandId: "b_acme", status });
      expect(await tenantStatus("b_acme")).toBe(status);
    },
  );

  it("refuses a database whose tenant_info names another brand, and keeps no client", async () => {
    h.findMany.mockResolvedValue([row("b_acme")]);
    h.owners.set("decrypted:url-b_acme", "b_globex");
    await expect(tenantFor("b_acme")).rejects.toThrow(TenantMismatchError);
    await expect(tenantFor("b_acme")).rejects.toMatchObject({ owner: "b_globex" });

    // Fixed underneath (the row now points at the right database): the next
    // call opens a fresh client rather than remembering the bad one.
    h.owners.set("decrypted:url-b_acme", "b_acme");
    await expect(tenantFor("b_acme")).resolves.toBeTruthy();
  });

  it("refuses a database with no tenant_info row at all", async () => {
    h.findMany.mockResolvedValue([row("b_acme")]);
    h.owners.delete("decrypted:url-b_acme");
    await expect(tenantFor("b_acme")).rejects.toMatchObject({ owner: null });
  });

  it("leaves a brand unavailable when its connection string won't decrypt", async () => {
    h.findMany.mockResolvedValue([row("b_acme")]);
    h.decrypt.mockImplementation(() => {
      throw new Error("bad key");
    });
    await expect(tenantFor("b_acme")).rejects.toMatchObject({ status: "none" });
  });
});

describe("callDb — where a brand's calls live", () => {
  it("is the brand's own database, the same client tenantFor hands out", async () => {
    h.findMany.mockResolvedValue([row("b_acme")]);
    const db = (await callDb("b_acme")) as unknown as Opened;
    expect(db).not.toBe(prisma);
    expect(db.opts.datasources.db.url).toBe("decrypted:url-b_acme");
    expect(await callDb("b_acme")).toBe(await tenantFor("b_acme"));
  });

  // This used to fall back to the control plane. That is exactly the write
  // that must never happen now: a call has one home, and if that home is not
  // ready the caller gets an error, not a different database.
  it("refuses a brand with no ready database rather than using the control plane", async () => {
    await expect(callDb("b_normal")).rejects.toThrow(TenantUnavailableError);
    await expect(callDb(null)).rejects.toThrow(TenantUnavailableError);
    h.findMany.mockResolvedValue([row("b_acme", "provisioning")]);
    invalidateTenantRegistry();
    await expect(callDb("b_acme")).rejects.toMatchObject({ status: "provisioning" });
  });
});

describe("registry loading", () => {
  it("caches, so every query is not also a registry read", async () => {
    h.findMany.mockResolvedValue([row("b_acme")]);
    await tenantFor("b_acme");
    await callDb("b_acme");
    await tenantStatus("b_acme");
    expect(h.findMany).toHaveBeenCalledTimes(1);
  });

  it("collapses a concurrent stampede into one read", async () => {
    h.findMany.mockResolvedValue([row("b_acme")]);
    await Promise.all([tenantFor("b_acme"), tenantFor("b_acme"), callDb("b_acme")]);
    expect(h.findMany).toHaveBeenCalledTimes(1);
  });

  it("re-reads after an explicit invalidation, so a status flip takes effect", async () => {
    h.findMany.mockResolvedValue([row("b_acme")]);
    expect(await tenantStatus("b_acme")).toBe("active");

    h.findMany.mockResolvedValue([row("b_acme", "disabled")]);
    invalidateTenantRegistry();
    expect(await tenantStatus("b_acme")).toBe("disabled");
    await expect(tenantFor("b_acme")).rejects.toMatchObject({ status: "disabled" });
  });

  // The realistic case: this deployment hasn't run the migration that creates
  // `brand_databases`. Nothing may route anywhere, and nothing may crash.
  it("treats an unreadable registry as 'no tenant is ready' instead of failing", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    h.findMany.mockRejectedValue(new Error('relation "brand_databases" does not exist'));
    await expect(callDb("b_acme")).rejects.toMatchObject({ status: "none" });
    expect(await activeTenantIds()).toEqual([]);
    await expect(tenantFor("b_acme")).rejects.toMatchObject({ status: "none" });
    warn.mockRestore();
  });
});

describe("allCallDbs", () => {
  // Maintenance jobs iterate this. One that skipped a brand would stop
  // archiving and pruning exactly that brand's database.
  it("lists every ACTIVE tenant, and only those", async () => {
    h.findMany.mockResolvedValue([row("b_acme"), row("b_globex"), row("b_new", "provisioning")]);
    const all = await allCallDbs();
    expect(all.map((e) => e.brandId)).toEqual(["b_acme", "b_globex"]);
    expect(all[0].db).toBe(await tenantFor("b_acme"));
  });

  it("is empty when no tenant is active", async () => {
    expect(await allCallDbs()).toEqual([]);
  });

  it("skips a tenant whose database names another brand, and keeps going", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    h.findMany.mockResolvedValue([row("b_acme"), row("b_globex")]);
    h.owners.set("decrypted:url-b_acme", "b_globex");
    const all = await allCallDbs();
    expect(all.map((e) => e.brandId)).toEqual(["b_globex"]);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe("assertRoutable", () => {
  // `where: { conversion: { userId } }` is a join into a table that, for a
  // tenant, is in a different database. There is no query that answers it —
  // so this must throw rather than quietly return other rows.
  it("rejects a filter that joins through a control-plane relation", () => {
    expect(() => assertRoutable({ conversion: { userId: "u1" } }, "callLog.updateMany")).toThrow(
      CrossDatabaseQueryError,
    );
    expect(() => assertRoutable({ brand: { slug: "acme" } }, "callLog.findMany")).toThrow(
      CrossDatabaseQueryError,
    );
  });

  it("allows plain column filters, which are what the split supports", () => {
    expect(() => assertRoutable({ conversionId: "c1", createdAt: { lt: new Date() } }, "x")).not.toThrow();
    expect(() => assertRoutable(undefined, "x")).not.toThrow();
  });

  it("names the offending clause, so the fix is obvious from the message", () => {
    expect(() => assertRoutable({ conversion: {} }, "callLog.count")).toThrow(
      /callLog\.count \(where\.conversion\)/,
    );
  });
});
