import { PrismaClient as TenantClient } from "@prisma/tenant-client";
import { prisma } from "../prisma.js";
import { decryptSecret } from "../lib/crypto.js";
import { currentBrandId } from "../lib/brandContext.js";
import { HttpError } from "../lib/http.js";
import { brandIdForOwner, installDirectoryMirror } from "./customerDirectory.js";

export type { TenantClient };

/* ------------------------------------------------------------------ *
 *  Two planes, and the way from one to the other.
 *
 *  `prisma` is the CONTROL PLANE — the platform's own database. Every
 *  brand also has a database of its own, the TENANT PLANE, and
 *  `tenantFor(brandId)` is how code gets a client for it: the registry
 *  (`brand_databases`) says where it is and whether it is ready, and the
 *  client is verified against the database's own `tenant_info` row the
 *  first time it is opened. A brand whose database is not ready gets an
 *  error, never the control plane instead — a customer's rows must never
 *  land in the wrong database.
 *
 *  ROUTING IS EXPLICIT, NEVER AMBIENT. It would be neater to wrap one
 *  client and have the control-plane client redirect itself — but relation filters
 *  into the other plane and `$transaction` across two databases would
 *  then become wrong answers instead of errors. So call sites ask for the
 *  client they mean, and `assertRoutable` refuses the shapes that cannot
 *  survive the split.
 *
 *  `callDb()` is the same client under the name the call paths use: a
 *  brand's calls live whole in its database (phase 2a), and every read or
 *  write of a call goes through it.
 * ------------------------------------------------------------------ */

/** How long a resolved registry entry is trusted before re-reading it. Short,
 *  because a status flip is an incident-response lever and should take effect
 *  in seconds, not on the next deploy. */
const REGISTRY_TTL_MS = 30_000;

/** Most tenants we keep a live client for. Each holds its own pool, so this
 *  bounds total connections; the least recently used is evicted. */
const MAX_CLIENTS = 25;

export type TenantStatus = "provisioning" | "migrating" | "active" | "failed" | "disabled";

interface Entry {
  brandId: string;
  status: TenantStatus | string;
  url: string;
}

let registry: Map<string, Entry> | null = null;
let registryLoadedAt = 0;
let inFlight: Promise<Map<string, Entry>> | null = null;

interface Pooled {
  client: TenantClient;
  lastUsed: number;
  url: string;
  verified: Promise<void>;
}

/** Live clients, keyed by brandId. */
const clients = new Map<string, Pooled>();

/**
 * Load (or reuse) the map of every brand's database, whatever its status.
 *
 * All statuses are kept so a caller can be told WHY a tenant is unavailable;
 * only `active` ever routes.
 */
async function loadRegistry(): Promise<Map<string, Entry>> {
  const fresh = registry && Date.now() - registryLoadedAt < REGISTRY_TTL_MS;
  if (fresh) return registry!;
  // Collapse a stampede: many concurrent requests after a TTL expiry share one
  // read rather than each issuing their own.
  if (inFlight) return inFlight;

  inFlight = (async () => {
    try {
      let rows: { brandId: string; status: string; urlEncrypted: string }[] = [];
      try {
        rows = await prisma.brandDatabase.findMany({
          select: { brandId: true, status: true, urlEncrypted: true },
        });
      } catch (e) {
        // The registry is unreadable — most often because this deployment
        // hasn't run the migration that creates `brand_databases` yet. "No
        // tenant is ready" is the safe answer: every tenant query refuses,
        // loudly, rather than going anywhere else.
        console.warn(
          "[tenantDb] registry unreadable, no tenant database is routable:",
          e instanceof Error ? e.message : e,
        );
        registry = new Map();
        registryLoadedAt = Date.now();
        return registry;
      }
      const next = new Map<string, Entry>();
      for (const r of rows) {
        try {
          next.set(r.brandId, {
            brandId: r.brandId,
            status: r.status,
            url: decryptSecret(r.urlEncrypted),
          });
        } catch {
          // A credential we cannot decrypt (rotated key, corrupt row) must not
          // silently route to the wrong place — leave the brand out, so it is
          // reported as unavailable and the mismatch is visible.
          console.error(`[tenantDb] cannot decrypt connection string for brand ${r.brandId}`);
        }
      }
      registry = next;
      registryLoadedAt = Date.now();
      return next;
    } finally {
      inFlight = null;
    }
  })();
  return inFlight;
}

/** Force the next resolution to re-read the registry — called after any change
 *  to a brand's database so it takes effect immediately on this instance. */
export function invalidateTenantRegistry(): void {
  registry = null;
  registryLoadedAt = 0;
}

/** Drop the least recently used client when the pool is full. */
function makeRoom(): void {
  if (clients.size < MAX_CLIENTS) return;
  let oldest: string | null = null;
  let oldestAt = Infinity;
  for (const [id, c] of clients) {
    if (c.lastUsed < oldestAt) [oldest, oldestAt] = [id, c.lastUsed];
  }
  if (oldest) {
    const evicted = clients.get(oldest)!;
    clients.delete(oldest);
    void evicted.client.$disconnect().catch(() => {});
  }
}

const LOG = process.env.NODE_ENV === "production" ? (["error"] as const) : (["error", "warn"] as const);

/** Thrown when a brand's database cannot be used: it doesn't exist, isn't
 *  ready, or has been paused. The status says which. */
export class TenantUnavailableError extends Error {
  constructor(
    public readonly brandId: string,
    public readonly status: string,
  ) {
    super(
      brandId
        ? `Brand ${brandId}'s database is not available (status: ${status}).`
        : "No brand in context — a tenant database needs a brand.",
    );
    this.name = "TenantUnavailableError";
  }
}

/** Thrown when a database's own tenant_info names a different brand — a
 *  mis-wired connection string. Loud, and the client is discarded. */
export class TenantMismatchError extends Error {
  constructor(
    public readonly brandId: string,
    public readonly owner: string | null,
  ) {
    super(
      `The database configured for brand ${brandId} belongs to ${owner ?? "no brand (no tenant_info row)"}. ` +
        `Refusing to use it — check brand_databases.`,
    );
    this.name = "TenantMismatchError";
  }
}

async function verifyIdentity(client: TenantClient, brandId: string): Promise<void> {
  const info = await client.tenantInfo.findUnique({ where: { id: "self" } });
  if (!info || info.brandId !== brandId) throw new TenantMismatchError(brandId, info?.brandId ?? null);
}

/**
 * The client for one brand's own database.
 *
 * Throws {@link TenantUnavailableError} unless the brand's database is
 * `active`, and {@link TenantMismatchError} if that database turns out to name
 * another brand. The identity check runs once per opened client and is
 * awaited by every caller that arrives while it is in flight.
 */
export async function tenantFor(brandId: string | null | undefined): Promise<TenantClient> {
  if (!brandId) throw new TenantUnavailableError("", "none");
  const entry = (await loadRegistry()).get(brandId);
  if (!entry) throw new TenantUnavailableError(brandId, "none");
  if (entry.status !== "active") throw new TenantUnavailableError(brandId, entry.status);

  const existing = clients.get(brandId);
  if (existing && existing.url === entry.url) {
    existing.lastUsed = Date.now();
    await existing.verified;
    return existing.client;
  }
  // The URL changed under us (re-provisioned database) — drop the stale pool
  // rather than keep querying a database that is no longer the tenant's.
  if (existing) void existing.client.$disconnect().catch(() => {});
  makeRoom();

  const client = new TenantClient({ datasources: { db: { url: entry.url } }, log: [...LOG] });
  // Main's thin directory follows this brand's accounts (phase 6): every
  // write to its `users` is reflected there before it returns.
  installDirectoryMirror(client, brandId);
  const verified = verifyIdentity(client, brandId).catch((e) => {
    clients.delete(brandId);
    void client.$disconnect().catch(() => {});
    throw e;
  });
  clients.set(brandId, { client, lastUsed: Date.now(), url: entry.url, verified });
  await verified;
  return client;
}

/** As `tenantFor`, but for the brand of the request currently being served. */
export async function currentTenant(): Promise<TenantClient> {
  return tenantFor(currentBrandId());
}

/**
 * The brand's database for the account signed in to a request — where that
 * customer's workspace is. Every customer belongs to a brand; a session minted
 * before tokens named one is sent to sign in again rather than guessed at.
 */
export async function requestTenant(req: { user?: { brandId?: string | null } }): Promise<TenantClient> {
  const brandId = req.user?.brandId;
  if (!brandId) throw new HttpError(401, "Please sign in again.", "session_stale");
  return tenantFor(brandId);
}

/** Where a brand's database is in its life, or "none" when it has no row. */
export async function tenantStatus(brandId: string | null | undefined): Promise<TenantStatus | "none"> {
  if (!brandId) return "none";
  const entry = (await loadRegistry()).get(brandId);
  return entry ? (entry.status as TenantStatus) : "none";
}

/** Every brand whose database is ready to be queried. Used by the sweeps,
 *  which have no ambient request brand and must visit each in turn. */
export async function activeTenantIds(): Promise<string[]> {
  return [...(await loadRegistry()).values()].filter((e) => e.status === "active").map((e) => e.brandId);
}

/**
 * The database of the brand an account belongs to — for code that has a user
 * id and no request to go by: a webhook recording a lead, the AI's booking
 * tool, a sweep. Throws as `tenantFor` does, including for an account with no
 * brand (the platform's own people have no customer workspace).
 */
export async function tenantForUser(userId: string | null | undefined): Promise<TenantClient> {
  return tenantFor(await brandIdForOwner(userId));
}

/**
 * Every active brand's database, with its brand.
 *
 * Platform-wide views and maintenance jobs iterate this. One that visited only
 * some brands would silently stop archiving, counting or repairing the ones it
 * skipped — the failure mode being unbounded growth, or a number that is quietly
 * wrong, in a customer's database.
 */
export async function allTenants(): Promise<{ brandId: string; db: TenantClient }[]> {
  const out: { brandId: string; db: TenantClient }[] = [];
  for (const brandId of await activeTenantIds()) {
    try {
      out.push({ brandId, db: await tenantFor(brandId) });
    } catch (e) {
      // One tenant that won't open (mismatch, gone mid-list) must not stop the
      // sweep for every other brand.
      console.warn(`[tenantDb] skipping brand ${brandId}:`, e instanceof Error ? e.message : e);
    }
  }
  return out;
}

/* ----------------------------- Two planes, one shape ----------------------------- */

/**
 * The control plane, addressed with the tenant client's types.
 *
 * Some tables exist in both planes with exactly the same shape — a ticket, a
 * department, a staff role, a notification — because the same code serves a
 * brand's inbox from the brand's database and the platform's inbox from the
 * control plane. That code is written once, against the tenant client's
 * types, and handed whichever database the lane lives in. The cast is honest
 * only for those identical tables; nothing else is reached through it.
 */
export function controlPlaneAsTenant(): TenantClient {
  return prisma as unknown as TenantClient;
}

export type SupportLane = "support" | "brand";

/**
 * Where a support lane's tickets, queues and saved replies live: a brand's
 * customer lane in the brand's own database, the brand-to-platform lane in the
 * control plane (phase 4).
 */
export async function laneDb(lane: SupportLane, brandId: string | null | undefined): Promise<TenantClient> {
  return lane === "brand" ? controlPlaneAsTenant() : tenantFor(brandId);
}

/**
 * The plane an account's own things live in, by the brand it belongs to: a
 * brand's person in the brand's database, the platform's own people in the
 * control plane. Roles, staff grants and notifications follow the person.
 */
export async function planeOf(brandId: string | null | undefined): Promise<TenantClient> {
  return brandId ? tenantFor(brandId) : controlPlaneAsTenant();
}

/** One brand's database, or every active one when no brand is given — the
 *  shape platform views take: a brand admin sees their own brand, the platform's
 *  own people see them all. */
export async function tenantsFor(
  brandId: string | null | undefined,
): Promise<{ brandId: string; db: TenantClient }[]> {
  if (brandId) return [{ brandId, db: await tenantFor(brandId) }];
  return allTenants();
}

/* --------------------------------- Calls ---------------------------------- */

/**
 * The database holding this brand's calls — its own. There is no other place a
 * call can be: a customer always belongs to a brand, and the brand's calls are
 * written whole into the brand's database. Throws when that database is not
 * ready, exactly as `tenantFor` does.
 */
export async function callDb(brandId: string | null | undefined): Promise<TenantClient> {
  return tenantFor(brandId);
}

/** As `callDb`, but for the brand of the request currently being served. */
export async function currentCallDb(): Promise<TenantClient> {
  return tenantFor(currentBrandId());
}

/** Every database that holds calls: one per active tenant. The call sweeps'
 *  name for `allTenants`. */
export async function allCallDbs(): Promise<{ brandId: string; db: TenantClient }[]> {
  return allTenants();
}

/* --------------------------- Safety rails -------------------------- */

/** Thrown when a query shape cannot survive being run against a tenant
 *  database. Loud on purpose — the alternative is a silently wrong answer. */
export class CrossDatabaseQueryError extends Error {
  constructor(what: string) {
    super(
      `${what} cannot run against a tenant database: it reaches into tables that live ` +
        `in the control plane. Resolve the ids there first, then filter by them. ` +
        `See docs/tenant-databases.md.`,
    );
    this.name = "CrossDatabaseQueryError";
  }
}

/**
 * Reject a `where` clause that filters through a control-plane relation.
 *
 * `where: { conversion: { userId } }` is a join into `conversions`, which for a
 * tenant is in a different database. There is no query that answers it, so the
 * only honest options are to fail or to return the wrong rows. The tenant
 * client's types refuse most such shapes at compile time; this catches the
 * ones built from JSON at run time.
 */
export function assertRoutable(where: Record<string, unknown> | undefined, label: string): void {
  if (!where) return;
  for (const key of ["conversion", "brand", "user"]) {
    if (where[key] !== undefined) throw new CrossDatabaseQueryError(`${label} (where.${key})`);
  }
}

/** Close every tenant connection — used on shutdown and by tests. */
export async function disconnectTenantDbs(): Promise<void> {
  const open = [...clients.values()];
  clients.clear();
  invalidateTenantRegistry();
  await Promise.all(open.map((c) => c.client.$disconnect().catch(() => {})));
}
