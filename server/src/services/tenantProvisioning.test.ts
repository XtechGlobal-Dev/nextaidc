import { describe, it, expect, vi, beforeEach } from "vitest";

// Provisioning state machine, not infrastructure: checks the order of steps and
// where each failure leaves a brand ("never half-works").

const h = vi.hoisted(() => {
  const brandDatabase = {
    findUnique: vi.fn(),
    findMany: vi.fn(),
    upsert: vi.fn(),
    update: vi.fn(),
    updateMany: vi.fn(),
  };
  const retirement = { create: vi.fn(), findMany: vi.fn(), delete: vi.fn() };
  const executed: string[] = [];
  return {
    brandDatabase,
    retirement,
    executed,
    brandFindUnique: vi.fn(),
    callLogFindMany: vi.fn(async () => []),
    neonConfigured: vi.fn(() => true),
    createProject: vi.fn(async () => ({
      projectId: "np_1",
      region: "aws-ap-southeast-2",
      url: "postgresql://u:p@ep-x-pooler.neon.tech/neondb",
      directUrl: "postgresql://u:p@ep-x.neon.tech/neondb",
    })),
    deleteProject: vi.fn(async (_projectId: string): Promise<void> => undefined),
    /** Mutable so a test can take the default region away. */
    env: { DATABASE_URL: "postgresql://u:p@main.host/app?sslmode=require", NEON_DEFAULT_REGION: "aws-ap-southeast-2" },
    deploy: vi.fn(async () => "ok"),
    latest: vi.fn(() => "0001_tenant_init"),
    /** What `SELECT brandId FROM tenant_info` answers — null for a fresh database. */
    tenantOwner: null as string | null,
    sweep: vi.fn(async () => ({ created: [], dropped: [], defaultRows: 0 })),
    resync: vi.fn(async () => 0),
    invalidate: vi.fn(),
  };
});

vi.mock("../prisma.js", () => ({
  prisma: {
    brand: { findUnique: h.brandFindUnique },
    brandDatabase: h.brandDatabase,
    tenantDatabaseRetirement: h.retirement,
    callLog: { findMany: h.callLogFindMany, update: vi.fn() },
  },
}));
vi.mock("../lib/crypto.js", () => ({
  encryptSecret: (s: string) => `enc(${s})`,
  decryptSecret: (s: string) => s.replace(/^enc\((.*)\)$/, "$1"),
}));
vi.mock("./neonProjects.js", () => ({
  isNeonConfigured: h.neonConfigured,
  createTenantProject: h.createProject,
  deleteTenantProject: h.deleteProject,
}));
vi.mock("./tenantMigrations.js", () => ({
  deployTenantMigrations: h.deploy,
  latestTenantMigration: h.latest,
}));
vi.mock("./tenantDb.js", () => ({ invalidateTenantRegistry: h.invalidate }));
// The tenant client is only ever asked to take the brand's leftover
// control-plane calls; with none to move it is never queried.
vi.mock("@prisma/tenant-client", () => ({
  PrismaClient: class {
    callLog = { upsert: vi.fn(), findMany: vi.fn(async () => []) };
    $disconnect() {
      return Promise.resolve();
    }
  },
}));
vi.mock("./callPartitions.js", () => ({ sweepCallPartitions: h.sweep }));
vi.mock("./customerDirectory.js", () => ({ rebuildDirectoryFromTenant: h.resync }));
vi.mock("../env.js", () => ({ env: h.env }));
// The direct-URL client only ever runs raw SQL here; record it and answer the
// one query the code asks (who owns this database).
vi.mock("@prisma/client", () => ({
  Prisma: {},
  PrismaClient: class {
    constructor(public opts: { datasources: { db: { url: string } } }) {}
    async $executeRawUnsafe(sql: string) {
      h.executed.push(`${this.opts.datasources.db.url} :: ${sql.replace(/\s+/g, " ").trim()}`);
      return 1;
    }
    async $queryRawUnsafe(sql: string) {
      if (sql.includes("tenant_info")) return h.tenantOwner ? [{ brandId: h.tenantOwner }] : [];
      return [];
    }
    $disconnect() {
      return Promise.resolve();
    }
  },
}));

const mod = await import("./tenantProvisioning.js");
const {
  provisionBrandDatabase,
  withSchema,
  localSchemaName,
  retireBrandDatabase,
  runTenantRetirementSweep,
  markStaleTenants,
  TENANT_RETIREMENT_DAYS,
} = mod;

const BRAND = { id: "b_acme", slug: "acme-voice" };

beforeEach(() => {
  vi.clearAllMocks();
  h.executed.length = 0;
  h.tenantOwner = null;
  h.neonConfigured.mockReturnValue(true);
  h.brandFindUnique.mockResolvedValue(BRAND);
  h.brandDatabase.findUnique.mockResolvedValue(null);
  h.brandDatabase.upsert.mockResolvedValue({});
  h.brandDatabase.update.mockResolvedValue({});
  h.callLogFindMany.mockResolvedValue([]);
});

/** Every status the brand_databases row was moved through, in order. */
function statuses(): string[] {
  const out: string[] = [];
  for (const call of h.brandDatabase.upsert.mock.calls) out.push(call[0].create.status);
  for (const call of h.brandDatabase.update.mock.calls) if (call[0].data.status) out.push(call[0].data.status);
  return out;
}

describe("provisioning on Neon", () => {
  it("creates the project, migrates, claims the database, then and only then goes active", async () => {
    const result = await provisionBrandDatabase({ brandId: "b_acme" });

    expect(h.createProject).toHaveBeenCalledWith("acme-voice", "aws-ap-southeast-2");
    // The deploy runs on the DIRECT endpoint — migrations take a lock a pooler can't hold.
    expect(h.deploy).toHaveBeenCalledWith("postgresql://u:p@ep-x.neon.tech/neondb");
    expect(h.executed.some((s) => s.includes('INSERT INTO "tenant_info"'))).toBe(true);
    expect(h.sweep).toHaveBeenCalledWith(0, expect.any(Date), expect.anything(), "call_logs");
    // The brand's people are copied in before it goes active, so its door
    // works from the first sign-in — on the direct endpoint, like the DDL.
    expect(h.resync).toHaveBeenCalledWith("b_acme", "postgresql://u:p@ep-x.neon.tech/neondb");
    expect(statuses()).toEqual(["provisioning", "migrating", "active"]);
    expect(result).toMatchObject({
      provider: "neon",
      neonProjectId: "np_1",
      region: "aws-ap-southeast-2",
      schemaVersion: "0001_tenant_init",
    });
    // Connection strings are stored encrypted, never as written.
    const stored = h.brandDatabase.upsert.mock.calls[0][0].create;
    expect(stored.urlEncrypted).toMatch(/^enc\(/);
    expect(h.invalidate).toHaveBeenCalled();
  });

  it("refuses to run without a region — the region is the point of a Neon tenant", async () => {
    h.env.NEON_DEFAULT_REGION = "";
    try {
      await expect(provisionBrandDatabase({ brandId: "b_acme" })).rejects.toThrow(/region/i);
      expect(h.createProject).not.toHaveBeenCalled();
    } finally {
      h.env.NEON_DEFAULT_REGION = "aws-ap-southeast-2";
    }
  });

  it("marks the brand failed with the reason when the migration breaks, and rethrows", async () => {
    h.deploy.mockRejectedValueOnce(new Error("tenant migrate deploy failed: boom"));
    await expect(provisionBrandDatabase({ brandId: "b_acme" })).rejects.toThrow(/boom/);
    expect(statuses()).toEqual(["provisioning", "failed"]);
    const failed = h.brandDatabase.update.mock.calls.find((c) => c[0].data.status === "failed");
    expect(failed![0].data.error).toMatch(/boom/);
  });

  it("resumes a failed attempt with the project it already has, never a second one", async () => {
    h.brandDatabase.findUnique.mockResolvedValue({
      status: "failed",
      provider: "neon",
      neonProjectId: "np_1",
      schemaName: "",
      region: "aws-ap-southeast-2",
      urlEncrypted: "enc(postgresql://u:p@ep-x-pooler.neon.tech/neondb)",
      directUrlEncrypted: "enc(postgresql://u:p@ep-x.neon.tech/neondb)",
      schemaVersion: "",
    });
    await provisionBrandDatabase({ brandId: "b_acme" });
    expect(h.createProject).not.toHaveBeenCalled();
    expect(h.deploy).toHaveBeenCalledWith("postgresql://u:p@ep-x.neon.tech/neondb");
    expect(statuses()).toEqual(["provisioning", "migrating", "active"]);
  });

  it("is a no-op for a brand whose database is already active", async () => {
    h.brandDatabase.findUnique.mockResolvedValue({
      status: "active",
      provider: "neon",
      neonProjectId: "np_1",
      schemaName: "",
      region: "aws-ap-southeast-2",
      schemaVersion: "0001_tenant_init",
    });
    const result = await provisionBrandDatabase({ brandId: "b_acme" });
    expect(result.neonProjectId).toBe("np_1");
    expect(h.createProject).not.toHaveBeenCalled();
    expect(h.deploy).not.toHaveBeenCalled();
  });

  it("refuses a database that already belongs to another brand", async () => {
    h.tenantOwner = "b_someone_else";
    await expect(provisionBrandDatabase({ brandId: "b_acme" })).rejects.toThrow(/already belongs/);
    expect(statuses()).toEqual(["provisioning", "failed"]);
  });
});

describe("provisioning without Neon — a schema on the platform database", () => {
  beforeEach(() => h.neonConfigured.mockReturnValue(false));

  it("derives a schema from the slug, creates it, and points the tenant URLs at it", async () => {
    const result = await provisionBrandDatabase({ brandId: "b_acme" });

    expect(result.provider).toBe("local-schema");
    expect(result.schemaName).toBe("tenant_acme_voice");
    expect(h.createProject).not.toHaveBeenCalled();
    expect(h.executed[0]).toContain('CREATE SCHEMA IF NOT EXISTS "tenant_acme_voice"');
    expect(h.deploy).toHaveBeenCalledWith(
      "postgresql://u:p@main.host/app?sslmode=require&schema=tenant_acme_voice&options=-c%20search_path%3Dtenant_acme_voice",
    );
    expect(statuses()).toEqual(["provisioning", "migrating", "active"]);
  });

  it("resumes with the schema it already has, rebuilding the URL from the environment", async () => {
    h.brandDatabase.findUnique.mockResolvedValue({
      status: "failed",
      provider: "local-schema",
      neonProjectId: "",
      schemaName: "tenant_acme_voice",
      region: "",
      urlEncrypted: "enc(postgresql://stale@old.host/app)",
      directUrlEncrypted: "enc(postgresql://stale@old.host/app)",
      schemaVersion: "",
    });
    await provisionBrandDatabase({ brandId: "b_acme" });
    expect(h.deploy).toHaveBeenCalledWith(expect.stringContaining("main.host/app?sslmode=require&schema=tenant_acme_voice"));
    expect(h.deploy).not.toHaveBeenCalledWith(expect.stringContaining("old.host"));
  });

  // Prisma qualifies its own queries with `schema`, but raw SQL runs against
  // the connection's search_path — which only `options` sets. Both, always.
  it("builds a schema URL that sets the search_path too, and keeps the rest of the string", () => {
    expect(withSchema("postgresql://u:p@h/db?sslmode=require", "tenant_x")).toBe(
      "postgresql://u:p@h/db?sslmode=require&schema=tenant_x&options=-c%20search_path%3Dtenant_x",
    );
    expect(withSchema("postgresql://u:p@h/db?schema=public", "tenant_x")).toBe(
      "postgresql://u:p@h/db?schema=tenant_x&options=-c%20search_path%3Dtenant_x",
    );
    expect(withSchema("postgresql://u:p@h/db", "tenant_x")).toBe(
      "postgresql://u:p@h/db?schema=tenant_x&options=-c%20search_path%3Dtenant_x",
    );
    expect(localSchemaName("acme-voice")).toBe("tenant_acme_voice");
  });
});

describe("keeping tenants current", () => {
  it("stops routing to active tenants whose schema is behind this build", async () => {
    h.latest.mockReturnValue("0002_next");
    h.brandDatabase.findMany.mockResolvedValue([{ brandId: "b_acme", schemaVersion: "0001_tenant_init" }]);
    h.brandDatabase.updateMany.mockResolvedValue({ count: 1 });
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});

    expect(await markStaleTenants()).toEqual(["b_acme"]);
    expect(h.brandDatabase.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: "migrating" }) }),
    );
    expect(h.invalidate).toHaveBeenCalled();
    spy.mockRestore();
    h.latest.mockReturnValue("0001_tenant_init");
  });

  it("leaves current tenants alone", async () => {
    h.brandDatabase.findMany.mockResolvedValue([]);
    expect(await markStaleTenants()).toEqual([]);
    expect(h.brandDatabase.updateMany).not.toHaveBeenCalled();
  });
});

describe("retirement", () => {
  it("records the database for removal 30 days out, rather than deleting it with the brand", async () => {
    h.brandDatabase.findUnique.mockResolvedValue({
      provider: "neon",
      neonProjectId: "np_1",
      schemaName: "",
      region: "aws-ap-southeast-2",
      brand: { slug: "acme-voice", name: "Acme Voice" },
    });
    const before = Date.now();
    await retireBrandDatabase("b_acme");
    const data = h.retirement.create.mock.calls[0][0].data;
    expect(data).toMatchObject({ brandSlug: "acme-voice", provider: "neon", neonProjectId: "np_1" });
    const days = (data.retireAfter.getTime() - before) / (24 * 60 * 60 * 1000);
    expect(Math.round(days)).toBe(TENANT_RETIREMENT_DAYS);
    expect(h.deleteProject).not.toHaveBeenCalled();
  });

  it("is a no-op for a brand that never got a database", async () => {
    h.brandDatabase.findUnique.mockResolvedValue(null);
    await retireBrandDatabase("b_nothing");
    expect(h.retirement.create).not.toHaveBeenCalled();
  });

  it("removes only the databases whose time is up, each independently", async () => {
    h.retirement.findMany.mockResolvedValue([
      { id: "r1", provider: "neon", neonProjectId: "np_1", schemaName: "", brandSlug: "acme" },
      { id: "r2", provider: "local-schema", neonProjectId: "", schemaName: "tenant_globex", brandSlug: "globex" },
      { id: "r3", provider: "neon", neonProjectId: "np_3", schemaName: "", brandSlug: "initech" },
    ]);
    h.deleteProject.mockImplementation(async (id: string) => {
      if (id === "np_3") throw new Error("Neon is down");
    });
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});

    const { removed } = await runTenantRetirementSweep();

    expect(removed).toBe(2);
    expect(h.deleteProject).toHaveBeenCalledWith("np_1");
    expect(h.executed.some((s) => s.includes('DROP SCHEMA IF EXISTS "tenant_globex" CASCADE'))).toBe(true);
    expect(h.retirement.delete.mock.calls.map((c) => c[0].where.id)).toEqual(["r1", "r2"]);
    spy.mockRestore();
  });
});
