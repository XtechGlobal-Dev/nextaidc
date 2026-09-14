import { PrismaClient } from "@prisma/client";
import { PrismaClient as TenantClient } from "@prisma/tenant-client";
import { prisma } from "../prisma.js";
import { encryptSecret, decryptSecret } from "../lib/crypto.js";
import { createTenantProject, deleteTenantProject, isNeonConfigured } from "./neonProjects.js";
import { invalidateTenantRegistry } from "./tenantDb.js";
import { sweepCallPartitions } from "./callPartitions.js";
import { deployTenantMigrations, latestTenantMigration } from "./tenantMigrations.js";
import { rebuildDirectoryFromTenant } from "./customerDirectory.js";
import { env } from "../env.js";

// A brand's own DB: create, keep current, retire. neon in prod, local-schema without NEON_API_KEY.
// Nothing routes until tenant_info names the brand — a half-finished run says "failed", and a retry resumes.

export type TenantProvider = "neon" | "local-schema";

/** How long a deleted brand's database is kept before the sweep removes it. */
export const TENANT_RETIREMENT_DAYS = 30;

/** Rows copied per batch. Transcripts make these rows large, so the batch is
 *  small — this is a background migration, not a race. */

// Short-lived client on the DIRECT endpoint — DDL takes session locks a pooler can't hold.
async function withDirect<T>(directUrl: string, fn: (db: PrismaClient) => Promise<T>): Promise<T> {
  const db = new PrismaClient({ datasources: { db: { url: directUrl } } });
  try {
    return await fn(db);
  } finally {
    await db.$disconnect().catch(() => {});
  }
}

/** Connection string for one schema. Needs both `schema` (Prisma's queries + migration history) and `options` search_path (raw SQL) — without `options` raw statements land in `public`. Hand-encoded because URLSearchParams writes "+" for space, which libpq won't read. */
export function withSchema(url: string, schema: string): string {
  const u = new URL(url);
  u.searchParams.delete("schema");
  u.searchParams.delete("options");
  const base = u.toString();
  const s = encodeURIComponent(schema);
  return `${base}${base.includes("?") ? "&" : "?"}schema=${s}&options=-c%20search_path%3D${s}`;
}

/** The schema a local-schema tenant lives in. Slugs are [a-z0-9-], so this is a
 *  safe identifier; it is still always quoted where it is used. */
export function localSchemaName(brandSlug: string): string {
  return `tenant_${brandSlug.replace(/-/g, "_")}`;
}

function localBaseUrls(): { url: string; directUrl: string } {
  return { url: env.DATABASE_URL, directUrl: process.env.DIRECT_URL || env.DATABASE_URL };
}

export interface ProvisionResult {
  brandId: string;
  provider: TenantProvider;
  neonProjectId: string;
  schemaName: string;
  region: string;
  schemaVersion: string;
}

/** Gives a brand its own DB at the current schema. Idempotent; a half-finished row resumes with what it has — never two databases for one brand. */
export async function provisionBrandDatabase(opts: {
  brandId: string;
  region?: string;
}): Promise<ProvisionResult> {
  const brand = await prisma.brand.findUnique({
    where: { id: opts.brandId },
    select: { id: true, slug: true },
  });
  if (!brand) throw new Error(`Unknown brand ${opts.brandId}`);

  const existing = await prisma.brandDatabase.findUnique({ where: { brandId: brand.id } });
  if (existing?.status === "active") {
    return {
      brandId: brand.id,
      provider: existing.provider as TenantProvider,
      neonProjectId: existing.neonProjectId,
      schemaName: existing.schemaName,
      region: existing.region,
      schemaVersion: existing.schemaVersion,
    };
  }

  // A row that already exists keeps its provider: switching one mid-way would
  // strand whatever the first attempt created.
  const provider: TenantProvider = existing
    ? (existing.provider as TenantProvider)
    : isNeonConfigured()
      ? "neon"
      : "local-schema";

  // --- 1. the database ---------------------------------------------------
  let neonProjectId = existing?.neonProjectId ?? "";
  let schemaName = existing?.schemaName ?? "";
  let region = existing?.region ?? "";
  let url = "";
  let directUrl = "";

  if (provider === "neon" && existing && neonProjectId) {
    url = decryptSecret(existing.urlEncrypted);
    directUrl = decryptSecret(existing.directUrlEncrypted);
  } else if (provider === "neon") {
    region = opts.region || env.NEON_DEFAULT_REGION;
    if (!region) {
      // Data residency is the point of a dedicated DB — never let Neon pick the region.
      throw new Error(
        "A region is required for a tenant database — set NEON_DEFAULT_REGION or choose one.",
      );
    }
    const project = await createTenantProject(brand.slug, region);
    neonProjectId = project.projectId;
    region = project.region;
    url = project.url;
    directUrl = project.directUrl;
  } else {
    // Derived from the environment on every run, never trusted from the row:
    // the platform's own connection string may have changed since.
    schemaName = existing?.schemaName || localSchemaName(brand.slug);
    const base = localBaseUrls();
    // Direct endpoint for BOTH — a pooler may drop the search_path option, and
    // connection counts don't matter in the dev shape.
    url = withSchema(base.directUrl, schemaName);
    directUrl = url;
    // Created here rather than left to the migrate step, so the schema exists
    // even if the deploy is what fails — a retry then finds it and resumes.
    await withDirect(base.directUrl, (db) =>
      db.$executeRawUnsafe(`CREATE SCHEMA IF NOT EXISTS "${schemaName}"`),
    );
  }

  await prisma.brandDatabase.upsert({
    where: { brandId: brand.id },
    create: {
      brandId: brand.id,
      provider,
      schemaName,
      neonProjectId,
      region,
      urlEncrypted: encryptSecret(url),
      directUrlEncrypted: encryptSecret(directUrl),
      status: "provisioning",
    },
    update: {
      provider,
      schemaName,
      neonProjectId,
      region,
      urlEncrypted: encryptSecret(url),
      directUrlEncrypted: encryptSecret(directUrl),
      status: "provisioning",
      error: "",
    },
  });

  try {
    // --- 2. the schema ---------------------------------------------------
    await deployTenantMigrations(directUrl);
    const schemaVersion = latestTenantMigration();

    await withDirect(directUrl, async (db) => {
      await claimTenant(db, brand);
      // Partitions now, so the first call after cutover lands in a real one, not the catch-all.
      await sweepCallPartitions(0, new Date(), db, "call_logs");
    });

    await prisma.brandDatabase.update({
      where: { brandId: brand.id },
      data: { status: "migrating", schemaVersion, provisionedAt: new Date(), error: "" },
    });

    // --- 3. the brand's defaults ------------------------------------------
    // Support queues, and Main's directory of its people.
    await seedSupportQueues(brand.id, directUrl);
    await rebuildDirectoryFromTenant(brand.id, directUrl);

    // --- 4. cut over -----------------------------------------------------
    // Only now does anything route here.
    await prisma.brandDatabase.update({
      where: { brandId: brand.id },
      data: { status: "active", migratedAt: new Date(), error: "" },
    });
    invalidateTenantRegistry();

    return { brandId: brand.id, provider, neonProjectId, schemaName, region, schemaVersion };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    await prisma.brandDatabase
      .update({ where: { brandId: brand.id }, data: { status: "failed", error: message } })
      .catch(() => {});
    invalidateTenantRegistry();
    throw e;
  }
}

// Stamps tenant_info with the brand, or refuses if the DB already belongs to another.
async function claimTenant(db: PrismaClient, brand: { id: string; slug: string }): Promise<void> {
  const rows = await db.$queryRawUnsafe<{ brandId: string }[]>(
    `SELECT "brandId" FROM "tenant_info" WHERE "id" = 'self'`,
  );
  const owner = rows[0]?.brandId;
  if (owner && owner !== brand.id) {
    throw new Error(
      `This database already belongs to brand ${owner}, not ${brand.id}. Refusing to reuse it.`,
    );
  }
  await db.$executeRawUnsafe(
    `INSERT INTO "tenant_info" ("id", "brandId", "brandSlug") VALUES ('self', $1, $2)
     ON CONFLICT ("id") DO UPDATE SET "brandSlug" = EXCLUDED."brandSlug"`,
    brand.id,
    brand.slug,
  );
}

// Starter support queues, only when the brand has none (a deleted "Sales" must not come back).
// Direct URL because the DB isn't routable yet; lazy import keeps tickets out of this graph.
async function seedSupportQueues(brandId: string, directUrl: string): Promise<void> {
  const tenant = new TenantClient({ datasources: { db: { url: directUrl } } });
  try {
    const { seedTicketDepartments } = await import("./tickets.js");
    await seedTicketDepartments("support", brandId, tenant);
  } finally {
    await tenant.$disconnect().catch(() => {});
  }
}

/* ------------------------- Keeping tenants current ------------------------ */

/** Migrates one tenant (`npm run tenant:migrate`). Routing stops while it runs and resumes only on success — a failed deploy keeps the door shut rather than run new code on an old table. */
export async function migrateTenant(brandId: string): Promise<{ from: string; to: string }> {
  const row = await prisma.brandDatabase.findUnique({ where: { brandId } });
  if (!row) throw new Error(`Brand ${brandId} has no database.`);
  const to = latestTenantMigration();
  if (row.status === "active" && row.schemaVersion === to) return { from: row.schemaVersion, to };

  await prisma.brandDatabase.update({ where: { brandId }, data: { status: "migrating", error: "" } });
  invalidateTenantRegistry();
  try {
    await deployTenantMigrations(decryptSecret(row.directUrlEncrypted));
    // Same partition step as provisioning, so the first call after the upgrade
    // lands in a real partition rather than the catch-all.
    const raw = new PrismaClient({
      datasources: { db: { url: decryptSecret(row.directUrlEncrypted) } },
    });
    try {
      await sweepCallPartitions(0, new Date(), raw, "call_logs");
    } finally {
      await raw.$disconnect().catch(() => {});
    }
    // The brand's defaults, and Main's directory of its people, brought whole.
    const directUrl = decryptSecret(row.directUrlEncrypted);
    await seedSupportQueues(brandId, directUrl);
    await rebuildDirectoryFromTenant(brandId, directUrl);
    await prisma.brandDatabase.update({
      where: { brandId },
      data: { status: "active", schemaVersion: to, migratedAt: new Date(), error: "" },
    });
    return { from: row.schemaVersion, to };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    await prisma.brandDatabase
      .update({ where: { brandId }, data: { error: message } })
      .catch(() => {});
    throw e;
  } finally {
    invalidateTenantRegistry();
  }
}

/** At boot: stops routing to tenants whose schema is behind this build, loudly — new code must not run against an old table. */
export async function markStaleTenants(): Promise<string[]> {
  const latest = latestTenantMigration();
  const stale = await prisma.brandDatabase.findMany({
    where: { status: "active", schemaVersion: { not: latest } },
    select: { brandId: true, schemaVersion: true },
  });
  if (stale.length === 0) return [];
  await prisma.brandDatabase.updateMany({
    where: { brandId: { in: stale.map((s) => s.brandId) } },
    data: {
      status: "migrating",
      error: `Schema behind this build (${latest}). Run: npm run tenant:migrate`,
    },
  });
  invalidateTenantRegistry();
  console.error(
    `[tenantDb] ${stale.length} tenant(s) are behind ${latest} and have stopped routing: ` +
      stale.map((s) => `${s.brandId} (${s.schemaVersion || "none"})`).join(", ") +
      ". Run `npm run tenant:migrate`.",
  );
  return stale.map((s) => s.brandId);
}

/* ------------------------------ Retirement -------------------------------- */

/** Queues a brand's DB for removal in 30 days. Call before deleting the brand row (it cascades brand_databases); until then the DB is untouched and restorable. */
export async function retireBrandDatabase(brandId: string): Promise<void> {
  const row = await prisma.brandDatabase.findUnique({
    where: { brandId },
    include: { brand: { select: { slug: true, name: true } } },
  });
  if (!row) return;
  await prisma.tenantDatabaseRetirement.create({
    data: {
      brandSlug: row.brand.slug,
      brandName: row.brand.name,
      provider: row.provider,
      neonProjectId: row.neonProjectId,
      schemaName: row.schemaName,
      region: row.region,
      retireAfter: new Date(Date.now() + TENANT_RETIREMENT_DAYS * 24 * 60 * 60 * 1000),
    },
  });
  invalidateTenantRegistry();
}

/** Remove every retired database whose 30 days are up. Daily. Each one is
 *  independent: a Neon outage on one must not stall the rest. */
export async function runTenantRetirementSweep(now = new Date()): Promise<{ removed: number }> {
  const due = await prisma.tenantDatabaseRetirement.findMany({
    where: { retireAfter: { lte: now } },
  });
  let removed = 0;
  for (const r of due) {
    try {
      if (r.provider === "neon") {
        if (r.neonProjectId) await deleteTenantProject(r.neonProjectId);
      } else if (r.schemaName) {
        await withDirect(localBaseUrls().directUrl, (db) =>
          db.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${r.schemaName}" CASCADE`),
        );
      }
      await prisma.tenantDatabaseRetirement.delete({ where: { id: r.id } });
      removed++;
      console.log(`[tenantDb] retired database of deleted brand ${r.brandSlug}`);
    } catch (e) {
      console.error(`[tenantDb] could not retire database of ${r.brandSlug}:`, e);
    }
  }
  return { removed };
}

/* -------------------------------- Health ---------------------------------- */

export interface TenantHealth {
  reachable: boolean;
  /** The database names this brand in tenant_info. */
  identity: "ok" | "mismatch" | "unknown";
  calls: number;
  schemaCurrent: boolean;
  error: string;
}

/** Connectivity + shape check for a tenant database, for the brand's page. */
export async function checkBrandDatabase(brandId: string): Promise<TenantHealth> {
  const row = await prisma.brandDatabase.findUnique({ where: { brandId } });
  if (!row) {
    return { reachable: false, identity: "unknown", calls: 0, schemaCurrent: false, error: "not provisioned" };
  }
  try {
    return await withDirect(decryptSecret(row.directUrlEncrypted), async (db) => {
      const info = await db.$queryRawUnsafe<{ brandId: string }[]>(
        `SELECT "brandId" FROM "tenant_info" WHERE "id" = 'self'`,
      );
      const counted = await db.$queryRawUnsafe<{ count: bigint }[]>(
        `SELECT count(*) AS count FROM "call_logs"`,
      );
      return {
        reachable: true,
        identity: info[0] ? (info[0].brandId === brandId ? "ok" : "mismatch") : "unknown",
        calls: Number(counted[0]?.count ?? 0),
        schemaCurrent: row.schemaVersion === latestTenantMigration(),
        error: "",
      };
    });
  } catch (e) {
    return {
      reachable: false,
      identity: "unknown",
      calls: 0,
      schemaCurrent: false,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}
