import { PrismaClient as TenantClient } from "@prisma/tenant-client";
import { prisma } from "../prisma.js";
import { decryptSecret } from "../lib/crypto.js";
import { currentBrandId } from "../lib/brandContext.js";
import { HttpError } from "../lib/http.js";
import { brandIdForOwner, installDirectoryMirror } from "./customerDirectory.js";

export type { TenantClient };

// `prisma` is the control plane; each brand has its own tenant DB, reached via `tenantFor`.
// ROUTING IS EXPLICIT, NEVER AMBIENT: a wrong-DB query is a cross-tenant data leak, so an
// unready tenant is an error (never the control plane) and `assertRoutable` refuses cross-plane shapes.

// Short on purpose: a status flip is an incident-response lever and must land in seconds.
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

// Every brand's DB, all statuses (so callers can say WHY one is unavailable). Only `active` routes.
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
        // Unreadable registry (usually the brand_databases migration hasn't run):
        // treat as "no tenant is ready" so every query refuses rather than routing elsewhere.
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
          // Undecryptable URL (rotated key, corrupt row): leave the brand out so it
          // reports unavailable instead of silently routing wrong.
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

/** Client for one brand's own DB. Throws unless the DB is `active` and its tenant_info names this brand; never falls back to the control plane. */
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

/** The signed-in account's brand DB. A session whose token names no brand is sent to sign in again, never guessed at. */
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

/** Brand DB for a user id with no request in hand (webhooks, tools, sweeps). Throws like `tenantFor`, including for brand-less platform staff. */
export async function tenantForUser(userId: string | null | undefined): Promise<TenantClient> {
  return tenantFor(await brandIdForOwner(userId));
}

/** Every active brand's DB. Sweeps iterate this; skipping a brand would silently stop archiving/repairing it. */
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

// Two planes, one shape.

/** The control plane typed as a tenant client. Honest only for tables identical in both planes (tickets, departments, roles, notifications). */
export function controlPlaneAsTenant(): TenantClient {
  return prisma as unknown as TenantClient;
}

export type SupportLane = "support" | "brand";

/** Where a lane's tickets live: support lane in the brand's DB, brand lane in the control plane. */
export async function laneDb(lane: SupportLane, brandId: string | null | undefined): Promise<TenantClient> {
  return lane === "brand" ? controlPlaneAsTenant() : tenantFor(brandId);
}

/** The plane an account's own things (roles, grants, notifications) live in: brand DB if it has a brand, else the control plane. */
export async function planeOf(brandId: string | null | undefined): Promise<TenantClient> {
  return brandId ? tenantFor(brandId) : controlPlaneAsTenant();
}

/** One brand's DB, or every active one when no brand is given (platform staff see all). */
export async function tenantsFor(
  brandId: string | null | undefined,
): Promise<{ brandId: string; db: TenantClient }[]> {
  if (brandId) return [{ brandId, db: await tenantFor(brandId) }];
  return allTenants();
}

// Calls.

/** The brand's own DB — a call has no other home. Throws like `tenantFor`. */
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

// Safety rails.

/** A query shape that can't run against a tenant DB. Loud on purpose — the alternative is a silently wrong answer. */
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

/** Rejects a `where` that joins through a control-plane relation — no tenant query can answer it, so fail rather than return wrong rows. Catches shapes built from JSON at runtime. */
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
