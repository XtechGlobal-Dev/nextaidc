import type { Role } from "@prisma/client";
import { PrismaClient as TenantClient, type Prisma as TenantPrisma } from "@prisma/tenant-client";
import { prisma } from "../prisma.js";

/* ------------------------------------------------------------------ *
 *  The thin customer directory (plan §7, decision Q4).
 *
 *  A brand's accounts live in the brand's own database, so Main has no
 *  way to answer "which brand is this email in?" or "how many people does
 *  this brand have?" without opening every tenant. This table is the one
 *  piece of customer PII kept in Main for exactly those two questions:
 *  brand, id, email, name, role. Nothing else — not a password hash, not a
 *  phone number, not a plan.
 *
 *  It is maintained by a middleware on every tenant client
 *  (`installDirectoryMirror`, wired in tenantDb.ts): every write to a
 *  brand's `users` is reflected here, same id, brand alongside. One
 *  place, one direction: tenant → Main. `rebuildDirectoryFromTenant`
 *  makes a brand's entries whole again from its database — run at
 *  provisioning and by `npm run tenant:migrate`.
 *
 *  Every write here is best-effort: a directory that lags is a search
 *  that misses, which is recoverable — an account write that fails
 *  because the directory did is not.
 * ------------------------------------------------------------------ */

export interface DirectoryPerson {
  id: string;
  email: string;
  fullName: string;
  role: Role | string;
  createdAt: Date;
}

export interface DirectoryHit {
  brandId: string;
  brand: { id: string; name: string; slug: string; status: string };
  userId: string;
  email: string;
  fullName: string;
  role: string;
  createdAt: Date;
}

function warn(what: string, brandId: string, e: unknown): void {
  console.warn(
    `[directory] could not ${what} for brand ${brandId} — run tenant:migrate to rebuild:`,
    e instanceof Error ? e.message : e,
  );
}

/* ------------------------- Which brand is this? ------------------------- */

const CACHE_MS = 5 * 60_000;
const brandOf = new Map<string, { brandId: string; at: number }>();

/**
 * The brand an account belongs to — for code that has a user id and no
 * request to go by: a webhook, a sweep, a notification. Null for the
 * platform's own people (and for an id nobody has). Cached briefly: an
 * account does not move between brands, and this sits under every
 * `tenantForUser` call.
 */
export async function brandIdForOwner(userId: string | null | undefined): Promise<string | null> {
  if (!userId) return null;
  const hit = brandOf.get(userId);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.brandId;
  try {
    const row = await prisma.customerDirectory.findFirst({ where: { userId }, select: { brandId: true } });
    if (row) brandOf.set(userId, { brandId: row.brandId, at: Date.now() });
    return row?.brandId ?? null;
  } catch {
    // Never let a lookup for a routing convenience break the thing being
    // recorded; the caller treats "no brand" as "not a brand account".
    return null;
  }
}

/** Drop what is remembered about an account (it was deleted, or moved). */
export function forgetBrandOf(userId: string): void {
  brandOf.delete(userId);
}

/* ------------------------------ Writes ------------------------------ */

/** Record (or refresh) one account in its brand's directory entry. */
export async function rememberInDirectory(brandId: string, u: DirectoryPerson): Promise<void> {
  const fields = { email: u.email, fullName: u.fullName, role: u.role as Role, createdAt: u.createdAt };
  try {
    await prisma.customerDirectory.upsert({
      where: { brandId_userId: { brandId, userId: u.id } },
      create: { brandId, userId: u.id, ...fields },
      update: fields,
    });
    brandOf.set(u.id, { brandId, at: Date.now() });
  } catch (e) {
    warn(`remember ${u.id}`, brandId, e);
  }
}

/** Drop an account from a brand's directory — it was deleted, or left the brand. */
export async function forgetInDirectory(brandId: string, userId: string): Promise<void> {
  forgetBrandOf(userId);
  try {
    await prisma.customerDirectory.deleteMany({ where: { brandId, userId } });
  } catch (e) {
    warn(`forget ${userId}`, brandId, e);
  }
}

/**
 * Make a brand's directory match this exact set of people: rows for each of
 * them, none for anyone else. Throws — this is the repair path, and a repair
 * that silently half-worked is worse than one that reports.
 */
export async function rebuildDirectory(brandId: string, people: DirectoryPerson[]): Promise<number> {
  const keep = people.map((p) => p.id);
  await prisma.$transaction(async (tx) => {
    await tx.customerDirectory.deleteMany({ where: { brandId, userId: { notIn: keep } } });
    for (const p of people) {
      const fields = { email: p.email, fullName: p.fullName, role: p.role as Role, createdAt: p.createdAt };
      await tx.customerDirectory.upsert({
        where: { brandId_userId: { brandId, userId: p.id } },
        create: { brandId, userId: p.id, ...fields },
        update: fields,
      });
    }
  });
  for (const p of people) brandOf.set(p.id, { brandId, at: Date.now() });
  return people.length;
}

/**
 * Rebuild a brand's directory from its own database. Takes the tenant URL
 * rather than going through `tenantFor()`, because at provisioning time the
 * database is not yet `active` and must not route.
 */
export async function rebuildDirectoryFromTenant(brandId: string, tenantUrl: string): Promise<number> {
  const tenant = new TenantClient({ datasources: { db: { url: tenantUrl } } });
  try {
    const people = await tenant.user.findMany({
      select: { id: true, email: true, fullName: true, role: true, createdAt: true },
    });
    return await rebuildDirectory(brandId, people);
  } finally {
    await tenant.$disconnect().catch(() => {});
  }
}

/* ------------------------------ The mirror ------------------------------ */

const USER_WRITES = new Set(["create", "update", "upsert", "delete", "updateMany", "deleteMany"]);

/** The ids a write is about to touch — read BEFORE it runs, because a delete
 *  leaves nothing to read and a narrowing `select` may not return the id. */
async function affected(client: TenantClient, params: TenantPrisma.MiddlewareParams): Promise<string[]> {
  const where = (params.args as { where?: TenantPrisma.UserWhereInput })?.where;
  if (params.action === "create" || !where) return [];
  const rows = await client.user.findMany({ where, select: { id: true } });
  return rows.map((r) => r.id);
}

/**
 * Keep Main's directory in step with one tenant's `users`. Installed on every
 * tenant client the moment it is opened (tenantDb.ts), so no write slips
 * through. Awaited on purpose: a sign-up routes by its brand a moment later
 * (`tenantForUser`), so the entry has to be there before the write returns.
 */
export function installDirectoryMirror(client: TenantClient, brandId: string): void {
  // A stand-in client (tests) may not carry middleware; the real one always does.
  if (typeof client.$use !== "function") return;
  client.$use(async (params, next) => {
    if (params.model !== "User" || !USER_WRITES.has(params.action)) return next(params);
    const before = await affected(client, params);
    const result = (await next(params)) as { id?: string } | { count: number } | null;

    const touched = new Set(before);
    if (result && "id" in result && result.id) touched.add(result.id);
    if (params.action === "create" && touched.size === 0) {
      // A create with a narrowing select — find it by the one unique field
      // every create carries.
      const email = (params.args as { data?: { email?: string } })?.data?.email;
      const made = email ? await client.user.findUnique({ where: { email }, select: { id: true } }) : null;
      if (made) touched.add(made.id);
    }
    for (const id of touched) {
      const row = await client.user.findUnique({
        where: { id },
        select: { id: true, email: true, fullName: true, role: true, createdAt: true },
      });
      if (row) await rememberInDirectory(brandId, row);
      else await forgetInDirectory(brandId, id);
    }
    return result;
  });
}

/* ------------------------------ Reads ------------------------------ */

/** "Find this customer, whichever brand." Email or name, any brand, from Main alone. */
export async function searchDirectory(q: string, limit = 25): Promise<DirectoryHit[]> {
  const needle = q.trim();
  if (!needle) return [];
  const rows = await prisma.customerDirectory.findMany({
    where: {
      OR: [
        { email: { contains: needle, mode: "insensitive" } },
        { fullName: { contains: needle, mode: "insensitive" } },
      ],
    },
    include: { brand: { select: { id: true, name: true, slug: true, status: true } } },
    orderBy: [{ email: "asc" }, { brandId: "asc" }],
    take: Math.min(Math.max(1, limit), 100),
  });
  return rows.map((r) => ({
    brandId: r.brandId,
    brand: r.brand,
    userId: r.userId,
    email: r.email,
    fullName: r.fullName,
    role: r.role,
    createdAt: r.createdAt,
  }));
}

/** Emails for a set of account ids, whichever brands they are in — for the
 *  platform's own ledgers and statements, which name customers by id. */
export async function emailsFor(userIds: string[]): Promise<Map<string, string>> {
  const ids = [...new Set(userIds.filter(Boolean))];
  if (!ids.length) return new Map();
  const rows = await prisma.customerDirectory.findMany({
    where: { userId: { in: ids } },
    select: { userId: true, email: true },
  });
  return new Map(rows.map((r) => [r.userId, r.email]));
}

export interface DirectoryCounts {
  admins: number;
  customers: number;
  total: number;
}

/** How many people each brand has, split by kind — the brand list's counts,
 *  answered without opening a single tenant. */
export async function directoryCounts(brandIds: string[]): Promise<Map<string, DirectoryCounts>> {
  const out = new Map<string, DirectoryCounts>();
  for (const id of brandIds) out.set(id, { admins: 0, customers: 0, total: 0 });
  if (!brandIds.length) return out;
  const rows = await prisma.customerDirectory.groupBy({
    by: ["brandId", "role"],
    where: { brandId: { in: brandIds } },
    _count: { _all: true },
  });
  for (const r of rows) {
    const bucket = out.get(r.brandId);
    if (!bucket) continue;
    const n = r._count._all;
    bucket.total += n;
    if (r.role === "ADMIN" || r.role === "STAFF") bucket.admins += n;
    else bucket.customers += n;
  }
  return out;
}
