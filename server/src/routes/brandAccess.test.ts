/* ------------------------------------------------------------------ *
 *  Multi-tenant access boundaries, end to end over HTTP.
 *
 *  Boots the REAL router stack — brandContext, requireAuth,
 *  requireSuperAdmin, the actual login handler and serialiser — against
 *  an in-memory Prisma stand-in, and drives it with real fetch calls.
 *  Unit tests can't catch what this is for: middleware ordering, a route
 *  mounted behind the wrong guard, a token that doesn't round-trip, or a
 *  brand admin reaching the platform's integration keys.
 * ------------------------------------------------------------------ */

// env.ts validates at import time and exits the process if these are missing.
// Set them before anything in the graph is imported (the router is pulled in
// with a dynamic import below, after this runs).
process.env.DATABASE_URL ||= "postgresql://user:pass@localhost:5432/test";
process.env.JWT_SECRET ||= "test-secret-at-least-thirty-two-characters-long";
process.env.NODE_ENV = "test";
// env.ts derives the wildcard apex from deployment config rather than
// hardcoding a brand's own domain as the default — set it explicitly so the
// new-brand subdomain assertion below has a known apex to check against.
process.env.PLATFORM_DOMAIN ||= "hello22.ai";

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import express from "express";
import bcrypt from "bcryptjs";
import type { Server } from "node:http";

/* --------------------------- In-memory Prisma --------------------------- */

interface Row {
  [key: string]: unknown;
}

const db = vi.hoisted(() => {
  const state: {
    users: Row[];
    brands: Row[];
    settings: Row[];
    brandSettings: Row[];
    profiles: Row[];
  } = { users: [], brands: [], settings: [], brandSettings: [], profiles: [] };

  /** Match a row against a (flat) Prisma `where`, following the few relation
   *  filters these routes actually use. */
  const matches = (row: Row, where: Record<string, unknown> = {}): boolean =>
    Object.entries(where).every(([key, cond]) => {
      const value = row[key];
      if (cond === null) return value === null || value === undefined;
      if (cond && typeof cond === "object") {
        const c = cond as Record<string, unknown>;
        if ("in" in c) return (c.in as unknown[]).includes(value);
        if ("notIn" in c) return !(c.notIn as unknown[]).includes(value);
        if ("not" in c) return value !== c.not;
      }
      return value === cond;
    });

  const model = (list: () => Row[], seq = { n: 0 }) => ({
    findUnique: vi.fn(async ({ where }: { where: Record<string, unknown> }) =>
      list().find((r) => matches(r, where)) ?? null,
    ),
    findFirst: vi.fn(async ({ where }: { where?: Record<string, unknown> } = {}) =>
      list().find((r) => matches(r, where)) ?? null,
    ),
    findMany: vi.fn(async ({ where }: { where?: Record<string, unknown> } = {}) =>
      list().filter((r) => matches(r, where)),
    ),
    count: vi.fn(async ({ where }: { where?: Record<string, unknown> } = {}) =>
      list().filter((r) => matches(r, where)).length,
    ),
    create: vi.fn(async ({ data }: { data: Row }) => {
      const row = { id: `id_${++seq.n}`, createdAt: new Date(), updatedAt: new Date(), ...data };
      list().push(row);
      return row;
    }),
    update: vi.fn(async ({ where, data }: { where: Record<string, unknown>; data: Row }) => {
      const row = list().find((r) => matches(r, where));
      if (!row) throw new Error("not found");
      Object.assign(row, data, { updatedAt: new Date() });
      return row;
    }),
    updateMany: vi.fn(async ({ where, data }: { where?: Record<string, unknown>; data: Row }) => {
      const rows = list().filter((r) => matches(r, where));
      for (const r of rows) Object.assign(r, data);
      return { count: rows.length };
    }),
    delete: vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
      const rows = list();
      const i = rows.findIndex((r) => matches(r, where));
      const [row] = rows.splice(i, 1);
      return row;
    }),
    createMany: vi.fn(async ({ data }: { data: Row | Row[] }) => {
      const rows = Array.isArray(data) ? data : [data];
      for (const d of rows) {
        list().push({ id: `id_${++seq.n}`, createdAt: new Date(), updatedAt: new Date(), ...d });
      }
      return { count: rows.length };
    }),
    deleteMany: vi.fn(async () => ({ count: 0 })),
    upsert: vi.fn(async ({ where, create }: { where: Record<string, unknown>; create: Row }) => {
      const row = list().find((r) => matches(r, where));
      if (row) return row;
      const made = { id: `id_${++seq.n}`, ...create };
      list().push(made);
      return made;
    }),
    groupBy: vi.fn(async () => []),
    aggregate: vi.fn(async () => ({ _sum: {}, _count: {} })),
  });

  return { state, model };
});

vi.mock("../prisma.js", () => {
  const backed: Record<string, any> = {
    // Main holds only the platform's own people now (phase 6); a brand's live in
    // its own database, and Main's thin directory names them.
    user: (() => {
      const m = db.model(() => db.state.users.filter((u) => !u.brandId));
      // Created here = one of the platform's own: no brand, kept in the shared list.
      m.create = vi.fn(async ({ data }: { data: Row }) => {
        const row = { id: `pu_${db.state.users.length + 1}`, createdAt: new Date(), updatedAt: new Date(), ...data, brandId: null };
        db.state.users.push(row);
        return row;
      });
      return m;
    })(),
    customerDirectory: db.model(() => db.state.users.filter((u) => u.brandId).map((u) => ({ ...u, userId: u.id }))),
    brand: db.model(() => db.state.brands),
    platformSetting: db.model(() => db.state.settings),
    brandSetting: db.model(() => db.state.brandSettings),
    profile: db.model(() => db.state.profiles),
  };
  // Any other model answers as an empty table. A Proxy rather than a hand-kept
  // list: these routes touch a long tail of models (transfer settings, bookings,
  // CRM rows) that this suite doesn't care about, and a missing one would
  // otherwise surface as "cannot read findUnique of undefined" — a crash that
  // looks like a product bug in a test about access control.
  const cache = new Map<string, unknown>();
  // $transaction just runs the callback against the same store: there is no
  // rollback to model here, and the point of these tests is the access
  // boundary, not atomicity.
  backed.$transaction = (fn: unknown) =>
    typeof fn === "function"
      ? (fn as (tx: unknown) => unknown)(proxy)
      : Promise.all(fn as Promise<unknown>[]);

  const proxy: unknown = new Proxy(backed, {
    get(target, prop: string) {
      if (prop in target) return target[prop];
      if (!cache.has(prop)) {
        // Each fallback model gets its OWN persistent array. Handing the model
        // a `() => []` thunk instead would mint a fresh array per call, so a
        // create() would vanish and the update() right after it would throw —
        // a failure of the stand-in that reads exactly like a broken route.
        const rows: Row[] = [];
        cache.set(prop, db.model(() => rows));
      }
      return cache.get(prop);
    },
  });
  return { prisma: proxy };
});

// Reconciling a subscription is a Stripe round-trip that has nothing to do with
// the access boundaries under test.
vi.mock("../services/trial.js", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  reconcileSubscription: vi.fn(async () => undefined),
}));

// Creating a brand also creates its database — a Neon project, or a schema on
// a real Postgres. That is infrastructure, and none of it belongs in a test
// about access boundaries, so the whole provisioning module is a stand-in that
// succeeds at once (tenantProvisioning.test.ts covers the real thing).
vi.mock("../services/tenantProvisioning.js", () => ({
  provisionBrandDatabase: vi.fn(async (opts: { brandId: string }) => ({
    brandId: opts.brandId,
    provider: "local-schema",
    neonProjectId: "",
    schemaName: "tenant_test",
    region: "",
    schemaVersion: "0001_tenant_init",
    callsMigrated: 0,
  })),
  retireBrandDatabase: vi.fn(async () => undefined),
  markStaleTenants: vi.fn(async () => []),
  migrateTenant: vi.fn(),
  runTenantRetirementSweep: vi.fn(async () => ({ removed: 0 })),
  checkBrandDatabase: vi.fn(async () => ({
    reachable: true,
    identity: "ok",
    calls: 0,
    schemaCurrent: true,
    error: "",
  })),
  TENANT_RETIREMENT_DAYS: 30,
}));

// Sign-in throttling has its own suite (middleware/rateLimit.test.ts). Here it
// would only turn the thirtieth sign-in of a run into a 429 that looks like an
// access-boundary failure.
vi.mock("../middleware/rateLimit.js", () => ({
  rateLimit: () =>
    Object.assign((_req: unknown, _res: unknown, next: () => void) => next(), { size: () => 0 }),
}));

// A brand's people live in the brand's own database, and sign-in reads it
// there. The stand-in for that plane is the same in-memory user list, filtered
// to the brand — which is exactly what the real tenant holds: this brand's
// accounts and nobody else's.
vi.mock("../services/tenantDb.js", async () => {
  const { prisma } = await import("../prisma.js");
  class TenantUnavailableError extends Error {
    constructor(
      public brandId: string,
      public status: string,
    ) {
      super(`Brand ${brandId}'s database is not available (status: ${status}).`);
    }
  }
  // Per brand, every other model is an empty in-memory table of its own — the
  // customer's workspace lives here now (calls, CRM, transfer, bookings, chat,
  // codes), and these suites only need the routes to get past the guard and
  // answer. Same shape as the control-plane stand-in above.
  const workspaces = new Map<string, Map<string, unknown>>();
  const tenantFor = async (brandId: string | null | undefined) => {
    if (!brandId) throw new TenantUnavailableError("", "none");
    let tables = workspaces.get(brandId);
    if (!tables) {
      tables = new Map();
      workspaces.set(brandId, tables);
    }
    const known = tables;
    const fixed: Record<string, unknown> = {
      user: (() => {
        const m = db.model(() => db.state.users.filter((u) => u.brandId === brandId));
        // A row created in the brand's database is the brand's: stamp it so the
        // filtered view above keeps it.
        m.create = vi.fn(async ({ data }: { data: Row }) => {
          const row = { id: `tu_${db.state.users.length + 1}`, createdAt: new Date(), updatedAt: new Date(), ...data, brandId };
          db.state.users.push(row);
          return row;
        });
        return m;
      })(),
      tenantInfo: { findUnique: async () => ({ id: "self", brandId }) },
      $disconnect: async () => undefined,
      // Both shapes the code uses: a list of writes, or a callback handed a client.
      $transaction: async (arg: unknown) =>
        typeof arg === "function" ? (arg as (tx: unknown) => unknown)(tenant) : Promise.all(arg as Promise<unknown>[]),
    };
    const tenant: unknown = new Proxy(fixed, {
      get(target, prop: string) {
        if (prop in target) return target[prop];
        if (!known.has(prop)) {
          const rows: Row[] = [];
          known.set(prop, db.model(() => rows));
        }
        return known.get(prop);
      },
    });
    return tenant;
  };
  return {
    tenantFor,
    currentTenant: async () => tenantFor("b_acme"),
    tenantStatus: async () => "active",
    callDb: async () => tenantFor("b_acme"),
    currentCallDb: async () => tenantFor("b_acme"),
    allCallDbs: async () => [],
    allTenants: async () => [],
    tenantsFor: async () => [],
    tenantForUser: async () => tenantFor("b_acme"),
    requestTenant: async () => tenantFor("b_acme"),
    // Support lanes and the person-plane helpers (phase 4): a brand lane in the
    // brand stand-in, the platform lane in the control-plane stand-in.
    controlPlaneAsTenant: () => prisma,
    laneDb: async (lane: string, brandId: string | null | undefined) =>
      lane === "brand" ? prisma : tenantFor(brandId),
    planeOf: async (brandId: string | null | undefined) => (brandId ? tenantFor(brandId) : prisma),
    assertRoutable: () => undefined,
    invalidateTenantRegistry: () => undefined,
    disconnectTenantDbs: async () => undefined,
    TenantUnavailableError,
    TenantMismatchError: TenantUnavailableError,
    CrossDatabaseQueryError: Error,
  };
});

const { apiRouter } = await import("./index.js");
const { brandContext } = await import("../middleware/brand.js");
const { errorHandler } = await import("../middleware/error.js");
const { loadBrands } = await import("../services/brands.js");

/* ------------------------------- The app -------------------------------- */

let server: Server;
let base: string;

const SUPER = { email: "superadmin@ai.com", password: "Super@001" };
const BRAND_ADMIN = { email: "admin@acmevoice.com", password: "Acme@12345" };

beforeAll(async () => {
  const hash = (p: string) => bcrypt.hashSync(p, 4); // low cost — this is a test

  db.state.brands.push({
    id: "b_acme",
    name: "Acme Voice",
    slug: "acme",
    customDomain: null,
    status: "active",
    logoLightUrl: "",
    logoDarkUrl: "",
    faviconUrl: "",
    themePreset: "emerald",
    primaryColor: "#059669",
    accentColor: "#10b981",
    fontFamily: "lora",
    fontStyle: "classic",
    darkModeDefault: false,
    tagline: "",
    supportEmail: "",
    supportPhone: "",
    createdById: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  });

  db.state.users.push(
    {
      id: "u_super",
      email: SUPER.email,
      fullName: "Super Admin",
      passwordHash: hash(SUPER.password),
      role: "SUPER_ADMIN",
      permissions: [],
      brandId: null,
      profile: null,
      staffRole: null,
      brand: null,
      createdAt: new Date(),
    },
    {
      id: "u_brand_admin",
      email: BRAND_ADMIN.email,
      fullName: "Jordan Blake",
      passwordHash: hash(BRAND_ADMIN.password),
      role: "ADMIN",
      permissions: [],
      brandId: "b_acme",
      profile: null,
      staffRole: null,
      brand: { name: "Acme Voice", status: "active" },
      createdAt: new Date(),
    },
  );

  await loadBrands();

  const app = express();
  app.use(express.json());
  app.use(brandContext);
  app.use("/api", apiRouter);
  app.use(errorHandler);

  await new Promise<void>((resolve) => {
    server = app.listen(0, () => {
      const addr = server.address();
      base = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
      resolve();
    });
  });
});

afterAll(() => new Promise<void>((r) => server.close(() => r())));

/** Which door each account signs in on. A brand's people sign in on their own
 *  brand's door; the platform's own people on the platform's (no header). */
const DOOR: Record<string, string> = {
  [BRAND_ADMIN.email]: "acme",
  "owner@northwind.test": "northwind",
};

/** `door: null` is the platform's own door, whatever the account. */
async function login(
  creds: { email: string; password: string },
  door: string | null = DOOR[creds.email] ?? null,
) {
  const res = await fetch(`${base}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(door ? { "X-Brand": door } : {}) },
    body: JSON.stringify(creds),
  });
  return { status: res.status, body: (await res.json()) as Record<string, never> };
}

const authed = (token: string, path: string, init: RequestInit = {}) =>
  fetch(`${base}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...init.headers },
  });

/* -------------------------------- Tests --------------------------------- */

describe("super admin sign-in", () => {
  it("signs in with the seeded credentials and comes back as SUPER_ADMIN", async () => {
    const { status, body } = await login(SUPER);
    expect(status).toBe(200);
    expect(body).toHaveProperty("token");
    const user = body.user as unknown as { role: string; brandId: string | null; email: string };
    expect(user.role).toBe("SUPER_ADMIN");
    expect(user.email).toBe(SUPER.email);
    // Platform-level on purpose: brandId null is what gives them the view over
    // every tenant (see lib/tenant.ts).
    expect(user.brandId).toBeNull();
  });

  it("rejects the wrong password without leaking which half was wrong", async () => {
    const { status, body } = await login({ email: SUPER.email, password: "wrong" });
    expect(status).toBe(401);
    expect(body.error).toMatch(/invalid email or password/i);
  });

  it("round-trips the token through /me", async () => {
    const { body } = await login(SUPER);
    const res = await authed(body.token, "/api/auth/me");
    expect(res.status).toBe(200);
    const me = (await res.json()) as { user: { role: string } };
    expect(me.user.role).toBe("SUPER_ADMIN");
  });
});

describe("brand admin sign-in", () => {
  it("signs in carrying their tenant", async () => {
    const { status, body } = await login(BRAND_ADMIN);
    expect(status).toBe(200);
    const user = body.user as unknown as { role: string; brandId: string; brandName: string };
    expect(user.role).toBe("ADMIN");
    expect(user.brandId).toBe("b_acme");
    expect(user.brandName).toBe("Acme Voice");
  });

  it("is locked out while their brand is suspended", async () => {
    const brand = db.state.brands.find((b) => b.id === "b_acme")!;
    const admin = db.state.users.find((u) => u.id === "u_brand_admin")!;
    brand.status = "suspended";
    admin.brand = { name: "Acme Voice", status: "suspended" };
    await loadBrands();
    try {
      const { status, body } = await login(BRAND_ADMIN);
      expect(status).toBe(403);
      expect(body.error).toMatch(/suspended/i);
    } finally {
      brand.status = "active";
      admin.brand = { name: "Acme Voice", status: "active" };
      await loadBrands();
    }
  });
});

describe("the super-admin wall", () => {
  let superToken = "";
  let brandToken = "";

  beforeAll(async () => {
    superToken = (await login(SUPER)).body.token;
    brandToken = (await login(BRAND_ADMIN)).body.token;
  });

  it("lets the super admin list brands", async () => {
    const res = await authed(superToken, "/api/super/brands");
    expect(res.status).toBe(200);
    const brands = (await res.json()) as { slug: string }[];
    expect(brands.map((b) => b.slug)).toContain("acme");
  });

  it("refuses the brands panel to a brand admin", async () => {
    const res = await authed(brandToken, "/api/super/brands");
    expect(res.status).toBe(403);
  });

  it("refuses the platform integration keys to a brand admin", async () => {
    // The whole point of the split: provider credentials are the platform's.
    const res = await authed(brandToken, "/api/admin/integrations");
    expect(res.status).toBe(403);
    const other = await authed(superToken, "/api/admin/integrations");
    expect(other.status).toBe(200);
  });

  it("refuses the API Center to a brand admin", async () => {
    const res = await authed(brandToken, "/api/admin/api-center/snapshot");
    expect(res.status).toBe(403);
  });

  it("refuses everything to an anonymous caller", async () => {
    const res = await fetch(`${base}/api/super/brands`);
    expect(res.status).toBe(401);
  });
});

describe("the customer workspace is closed to the super admin", () => {
  let superToken = "";
  let brandToken = "";

  beforeAll(async () => {
    superToken = (await login(SUPER)).body.token;
    brandToken = (await login(BRAND_ADMIN)).body.token;
  });

  // The platform owner runs the platform; they have no business, no agent and no
  // subscription. Hiding the nav isn't enough — a typed URL has to be refused
  // too, and a stray GET must never mint a Profile for them.
  const CUSTOMER_APIS = [
    "/api/agent",
    "/api/calls",
    "/api/crm",
    "/api/transfer",
    "/api/trial/status",
    "/api/booking/overview",
  ];

  it("refuses every customer feature API", async () => {
    for (const path of CUSTOMER_APIS) {
      const res = await authed(superToken, path);
      expect({ path, status: res.status }).toEqual({ path, status: 403 });
    }
  });

  it("says why, rather than looking like a missing page", async () => {
    const res = await authed(superToken, "/api/agent");
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/customer accounts/i);
  });

  it("lets a brand ADMIN past the same guard", async () => {
    // The wall is specifically the SUPER_ADMIN's: a brand admin keeps a real
    // agent and profile so they can place test calls through their own tenant.
    //
    // Asserted as "the guard didn't refuse them" rather than "200", because what
    // a route does AFTER the guard depends on rows this stand-in doesn't hold
    // (a trial needs a Profile). Pinning 200 here would test the stub, not the
    // boundary — so check the refusal specifically, by its status AND message.
    for (const path of CUSTOMER_APIS) {
      const res = await authed(brandToken, path);
      const body = await res.text();
      expect({ path, refused: res.status === 403 }).toEqual({ path, refused: false });
      expect(body).not.toContain("This area is for customer accounts");
    }
  });

  it("never creates a Profile row for the super admin", async () => {
    await authed(superToken, "/api/profile");
    expect(db.state.profiles).toHaveLength(0);
  });
});

describe("brand-scoped admin sections are closed to the super admin", () => {
  let superToken = "";
  let brandToken = "";

  beforeAll(async () => {
    superToken = (await login(SUPER)).body.token;
    brandToken = (await login(BRAND_ADMIN)).body.token;
  });

  // A tenant's own customer base — its signup metrics, its customers, their
  // subscriptions, the voices they may pick from. The brand admin runs those,
  // and one brand's customer list is not something the platform owner browses.
  const BRAND_SECTIONS = [
    "/api/admin/overview",
    "/api/admin/customers",
    "/api/admin/subscriptions",
    "/api/admin/voice-categories",
  ];

  it("refuses them to the super admin", async () => {
    for (const path of BRAND_SECTIONS) {
      const res = await authed(superToken, path);
      expect({ path, status: res.status }).toEqual({ path, status: 403 });
    }
  });

  it("explains that the section belongs to a brand", async () => {
    const res = await authed(superToken, "/api/admin/customers");
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/belongs to a brand/i);
  });

  it("covers the nested customer routes too, not just the list", async () => {
    // The rule is applied at requirePermission, so every route in the section
    // inherits it — including the ones an id makes look like a different page.
    for (const path of [
      "/api/admin/customers/u_brand_admin",
      "/api/admin/customers/u_brand_admin/detail",
    ]) {
      const res = await authed(superToken, path);
      expect({ path, status: res.status }).toEqual({ path, status: 403 });
    }
  });

  it("leaves the platform sections open to the super admin", async () => {
    for (const path of ["/api/admin/plans", "/api/admin/coupons", "/api/admin/audit"]) {
      const res = await authed(superToken, path);
      expect({ path, refused: res.status === 403 }).toEqual({ path, refused: false });
    }
  });

  it("still lets a brand ADMIN run their own customer base", async () => {
    for (const path of BRAND_SECTIONS) {
      const res = await authed(brandToken, path);
      expect({ path, refused: res.status === 403 }).toEqual({ path, refused: false });
    }
  });
});

describe("platform-only admin sections", () => {
  let superToken = "";
  let brandToken = "";

  beforeAll(async () => {
    superToken = (await login(SUPER)).body.token;
    brandToken = (await login(BRAND_ADMIN)).body.token;
  });

  // The audit trail belongs to the platform owner — an audit log a tenant's own
  // admin can read is a weak audit log.
  //
  // The reseller/affiliate programme used to sit here too. It no longer does: a
  // brand recruits and pays its own resellers, so a brand admin reaches those
  // routes and `tenantScope` inside the handlers is what keeps one brand out of
  // another's rows. Covered by "opens the reseller programme to a brand admin".
  const PLATFORM_APIS = ["/api/admin/audit"];

  it("refuses them to a brand admin", async () => {
    for (const path of PLATFORM_APIS) {
      const res = await authed(brandToken, path);
      expect({ path, status: res.status }).toEqual({ path, status: 403 });
    }
  });

  it("explains that the section belongs to the platform", async () => {
    const res = await authed(brandToken, "/api/admin/audit");
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/belongs to the platform/i);
  });

  it("opens the reseller programme to a brand admin", async () => {
    // The mirror of the test above: a brand runs its own reseller programme, so
    // requirePermission lets any ADMIN through these two. The tenant walls move
    // into the handlers (tenantScope), they are no longer a flat 403.
    for (const path of ["/api/admin/resellers", "/api/admin/commissions"]) {
      const res = await authed(brandToken, path);
      expect({ path, status: res.status }).toEqual({ path, status: 200 });
    }
  });

  it("keeps them open to the super admin", async () => {
    for (const path of PLATFORM_APIS) {
      const res = await authed(superToken, path);
      expect({ path, refused: res.status === 403 }).toEqual({ path, refused: false });
    }
  });

  it("drops them from the staff permission matrix", async () => {
    // Audit: leaving a grantable box that authorizes nothing would be a trap —
    // a role with only that box ticked would leave its members with no usable
    // access. Resellers is absent for the opposite reason: it is open to every
    // ADMIN, but is deliberately not delegated down to staff, so there is no
    // box to tick for it either.
    const res = await authed(superToken, "/api/admin/permissions");
    expect(res.status).toBe(200);
    const cfg = (await res.json()) as { sections: { key: string }[] };
    const keys = cfg.sections.map((sec) => sec.key);
    expect(keys).not.toContain("resellers");
    expect(keys).not.toContain("audit");
    // The platform's own team never delegates a BRAND's day-to-day either —
    // same trap, same fix: a brand-scoped box would authorize nothing for
    // platform staff (requirePermission refuses the super admin outright, and
    // a platform STAFF member has no tenant for the key to act on), so the
    // matrix doesn't offer it.
    expect(keys).not.toContain("customers");
    expect(keys).not.toContain("tickets");
    // …while the sections the platform genuinely runs stay grantable.
    expect(keys).toEqual(expect.arrayContaining(["plans", "coupons"]));
  });

  it("offers a brand admin their own sections instead", async () => {
    // The mirror image: a brand delegates its OWN customer base to its staff,
    // and never the platform's inbox (that queue is between this brand and the
    // platform, not something to hand a teammate).
    const res = await authed(brandToken, "/api/admin/permissions");
    expect(res.status).toBe(200);
    const cfg = (await res.json()) as { sections: { key: string }[] };
    const keys = cfg.sections.map((sec) => sec.key);
    expect(keys).toEqual(expect.arrayContaining(["customers", "tickets", "plans", "coupons"]));
    expect(keys).not.toContain("brand_tickets");
  });
});

describe("Platform Settings, minus the credentials", () => {
  let superToken = "";
  let brandToken = "";

  beforeAll(async () => {
    superToken = (await login(SUPER)).body.token;
    brandToken = (await login(BRAND_ADMIN)).body.token;
  });

  // The settings tabs that configure how the product behaves and looks. They
  // hold no secrets, so an admin may open them.
  const SETTINGS_APIS = [
    "/api/admin/branding",
    "/api/admin/prompt-template",
    "/api/admin/prompt-template/history",
    "/api/admin/country-styles",
    "/api/admin/industries",
    "/api/admin/agent-default-names",
    "/api/admin/agent-llm",
    "/api/admin/transcriber-fallback",
    "/api/admin/onboarding",
    "/api/admin/seo",
  ];

  it("lets a brand admin read the settings tabs", async () => {
    // In parallel: ten sequential round trips against a live Express app was
    // creeping up on the default timeout, and nothing here depends on order.
    const results = await Promise.all(
      SETTINGS_APIS.map(async (path) => ({ path, status: (await authed(brandToken, path)).status })),
    );
    expect(results).toEqual(SETTINGS_APIS.map((path) => ({ path, status: 200 })));
  });

  it("still refuses them the provider credentials", async () => {
    // The one tab that stays behind the wall — Vapi, Twilio, SMTP, OpenAI keys
    // are the platform's, and billed to the platform.
    for (const path of [
      "/api/admin/integrations",
      "/api/admin/integrations/whatsapp/info",
    ]) {
      const res = await authed(brandToken, path);
      expect({ path, status: res.status }).toEqual({ path, status: 403 });
    }
  });

  it("keeps platform billing policy super-admin only", async () => {
    // Trial length, grace and the reporting FX rates are one value shared by
    // every tenant — they live on the Plans page, not in these tabs.
    for (const path of [
      "/api/admin/trial-days",
      "/api/admin/grace-period",
      "/api/admin/fx-rates",
    ]) {
      const res = await authed(brandToken, path);
      expect({ path, status: res.status }).toEqual({ path, status: 403 });
    }
  });

  it("leaves the super admin able to open everything here", async () => {
    for (const path of [...SETTINGS_APIS, "/api/admin/integrations", "/api/admin/trial-days"]) {
      const res = await authed(superToken, path);
      expect({ path, refused: res.status === 403 }).toEqual({ path, refused: false });
    }
  });
});

describe("brand editor endpoints", () => {
  let token = "";
  beforeAll(async () => {
    token = (await login(SUPER)).body.token;
  });

  it("serves the theme catalog the pickers are built from", async () => {
    const res = await authed(token, "/api/super/brands/catalog");
    expect(res.status).toBe(200);
    const cat = (await res.json()) as {
      presets: unknown[];
      fonts: { group: string }[];
      defaults: { preset: string; font: string };
    };
    expect(cat.presets.length).toBeGreaterThanOrEqual(10);
    expect(cat.fonts.filter((f) => f.group === "business").length).toBeGreaterThan(0);
    expect(cat.fonts.filter((f) => f.group === "classic").length).toBeGreaterThan(0);
    expect(cat.defaults.font).toBe("inter");
  });

  it("reports a taken subdomain, a reserved one, and a free one", async () => {
    const check = async (slug: string) =>
      (await (await authed(token, `/api/super/brands/slug-check?slug=${slug}`)).json()) as {
        available: boolean;
        reason: string;
      };
    expect((await check("acme")).available).toBe(false);
    expect((await check("www")).reason).toMatch(/reserved/i);
    expect((await check("northwind")).available).toBe(true);
  });

  it("creates a brand and its administrator in one call", async () => {
    const res = await authed(token, "/api/super/brands", {
      method: "POST",
      body: JSON.stringify({
        name: "Northwind Voice",
        slug: "northwind",
        themePreset: "violet",
        fontFamily: "playfair",
        admin: {
          email: "owner@northwind.test",
          fullName: "Dana Reed",
          password: "Northwind@1",
          sendWelcomeEmail: false,
        },
      }),
    });
    expect(res.status).toBe(201);
    const out = (await res.json()) as {
      brand: {
        slug: string;
        status: string;
        fontStyle: string;
        primaryColor: string;
        domainStatus: string;
      };
      admin: { email: string } | null;
      loginUrl: string;
      pathUrl: string;
      domain: unknown;
    };
    expect(out.brand.slug).toBe("northwind");
    // Its database was set up (stubbed above) before the door opened.
    expect(out.brand.status).toBe("active");
    // Picking a preset fills both colours; picking a serif sets the family.
    expect(out.brand.primaryColor).toBe("#7c3aed");
    expect(out.brand.fontStyle).toBe("classic");
    expect(out.admin?.email).toBe("owner@northwind.test");

    // The brand's own subdomain, which the wildcard record and its wildcard
    // certificate already cover — so a new brand is reachable immediately with
    // no DNS to add and nothing to wait on.
    expect(out.loginUrl).toBe("https://northwind.hello22.ai");
    // The path-routed address survives alongside it: it needs no DNS at all, so
    // it still works while a wildcard propagates or on a preview deployment.
    expect(out.pathUrl).toMatch(/\/northwind$/);
    // No vanity domain was named, so there is nothing for a client to publish.
    expect(out.brand.domainStatus).toBe("none");
    expect(out.domain).toBeNull();

    // The new admin is a real, scoped account — they can sign in, they land
    // inside the brand that was just created, and they are NOT admitted to the
    // panel that created them.
    const brandId = (out.brand as unknown as { id: string }).id;
    const theirs = await login({ email: "owner@northwind.test", password: "Northwind@1" });
    expect(theirs.status).toBe(200);
    expect((theirs.body.user as unknown as { brandId: string }).brandId).toBe(brandId);
    expect((await authed(theirs.body.token, "/api/super/brands")).status).toBe(403);
  });

  it("refuses a duplicate admin email before creating the brand", async () => {
    const before = db.state.brands.length;
    const res = await authed(token, "/api/super/brands", {
      method: "POST",
      body: JSON.stringify({
        name: "Clashing Brand",
        slug: "clashing",
        admin: { email: SUPER.email, fullName: "Someone", password: "Password@1" },
      }),
    });
    expect(res.status).toBe(400);
    // The failure must not leave an orphan tenant behind.
    expect(db.state.brands).toHaveLength(before);
  });
});

describe("public config", () => {
  it("returns no brand on the platform's own host", async () => {
    const res = await fetch(`${base}/api/config`);
    const cfg = (await res.json()) as { brand: unknown };
    expect(res.status).toBe(200);
    expect(cfg.brand).toBeNull();
  });

  it("returns the tenant's palette and font when the request names a brand", async () => {
    const res = await fetch(`${base}/api/config`, { headers: { "x-brand-id": "b_acme" } });
    const cfg = (await res.json()) as {
      brand: { name: string; theme: { primaryColor: string; fontStack: string; googleFamily: string } } | null;
    };
    expect(cfg.brand?.name).toBe("Acme Voice");
    expect(cfg.brand?.theme.primaryColor).toBe("#059669");
    expect(cfg.brand?.theme.fontStack).toContain("Lora");
    expect(cfg.brand?.theme.googleFamily).toBe("Lora");
    // Nothing secret rides along on a public, unauthenticated endpoint.
    expect(JSON.stringify(cfg.brand)).not.toMatch(/token|secret|password/i);
  });
});

/* ------------------------- Brand setup policies -------------------------- */

describe("brand setup policies", () => {
  const acme = () => db.state.brands.find((b) => b.id === "b_acme")!;
  const onAcme = { "X-Brand": "acme" };

  it("closes self-serve sign-up on an invite-only brand", async () => {
    acme().signupMode = "invite";
    await loadBrands();
    try {
      // Checked before the body is looked at, so the answer is the same 403
      // whatever was sent — no validation hints leak from a closed door.
      const closed = await fetch(`${base}/api/auth/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...onAcme },
        body: JSON.stringify({}),
      });
      expect(closed.status).toBe(403);
      expect(((await closed.json()) as { error: string }).error).toMatch(/Acme Voice/);
    } finally {
      acme().signupMode = "public";
      await loadBrands();
    }
  });

  it("keeps a public brand's door open", async () => {
    // Reaches validation (400) rather than the closed-door 403: the door is open.
    const open = await fetch(`${base}/api/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...onAcme },
      body: JSON.stringify({}),
    });
    expect(open.status).toBe(400);
  });

  it("never takes a sign-up on the platform's own door", async () => {
    // Every customer belongs to a brand. With no brand resolved there is nowhere
    // for the account to go, so it is refused before the body is read — not
    // quietly filed under the platform, which is what used to happen.
    const platform = await fetch(`${base}/api/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(platform.status).toBe(403);
    expect(((await platform.json()) as { error: string }).error).toMatch(/provider/i);
  });

  it("answers 403 for a switched-off module's API on that brand, and not elsewhere", async () => {
    acme().modules = { transfer: false };
    await loadBrands();
    try {
      const off = await fetch(`${base}/api/transfer`, { headers: onAcme });
      expect(off.status).toBe(403);
      const body = (await off.json()) as { error: string };
      expect(body.error).toMatch(/Call Transfer/);
      // Same route with no brand: the gate stands aside and auth answers.
      const platform = await fetch(`${base}/api/transfer`);
      expect(platform.status).toBe(401);
      // A module the brand left on is untouched.
      const crm = await fetch(`${base}/api/crm`, { headers: onAcme });
      expect(crm.status).toBe(401);
    } finally {
      acme().modules = {};
      await loadBrands();
    }
  });

  it("lists only the plans a brand chose to sell", async () => {
    const { prisma } = await import("../prisma.js");
    const plan = (id: string, name: string) => ({
      id,
      name,
      displayName: name,
      description: "",
      priceCents: 1000,
      currency: "usd",
      interval: "month",
      intervalCount: 1,
      includedMinutes: 100,
      features: [],
      active: true,
      sortOrder: 1,
      voiceCategoryId: null,
      createdAt: new Date(),
    });
    await prisma.subscriptionPlan.create({ data: plan("p_basic", "Basic") });
    await prisma.subscriptionPlan.create({ data: plan("p_pro", "Pro") });

    acme().planIds = ["p_pro"];
    await loadBrands();
    try {
      const onBrand = (await (await fetch(`${base}/api/billing/plans`, { headers: onAcme })).json()) as {
        id: string;
      }[];
      expect(onBrand.map((p) => p.id)).toEqual(["p_pro"]);
      // No allow-list → every active plan, which is what the platform door sells.
      const all = (await (await fetch(`${base}/api/billing/plans`)).json()) as { id: string }[];
      expect(all.map((p) => p.id).sort()).toEqual(["p_basic", "p_pro"]);
    } finally {
      acme().planIds = [];
      await loadBrands();
    }
  });
});

/* ------------------------- Brand pricing & wallet ------------------------ */

describe("brand pricing and wallet", () => {
  const onAcme = { "X-Brand": "acme" };

  it("keeps a brand's pricing and wallet away from the super admin's own panel", async () => {
    const { body } = await login(SUPER);
    const res = await authed(body.token, "/api/admin/brand/pricing");
    expect(res.status).toBe(403);
    const wallet = await authed(body.token, "/api/admin/brand/wallet");
    expect(wallet.status).toBe(403);
  });

  it("lets the brand admin add a charge, which its customers then see as the price", async () => {
    // The in-memory brand row predates the column; the real default is true.
    db.state.brands.find((b) => b.id === "b_acme")!.addonEditable = true;
    const { body } = await login(BRAND_ADMIN);
    const put = await authed(body.token, "/api/admin/brand/pricing/p_pro", {
      method: "PUT",
      body: JSON.stringify({ addonCents: 2000 }),
    });
    expect(put.status).toBe(200);
    const row = (await put.json()) as { basePriceCents: number; brandPriceCents: number };
    expect(row.basePriceCents).toBe(1000);
    expect(row.brandPriceCents).toBe(3000);

    const list = await authed(body.token, "/api/admin/brand/pricing");
    expect(list.status).toBe(200);
    const pricing = (await list.json()) as { rows: { planId: string; addonCents: number }[] };
    expect(pricing.rows.find((r) => r.planId === "p_pro")?.addonCents).toBe(2000);

    // Acme's door sells Pro at 30.00; the platform's own door still at 10.00.
    const onBrand = (await (await fetch(`${base}/api/billing/plans`, { headers: onAcme })).json()) as {
      id: string;
      priceCents: number;
      basePriceCents: number;
      addonCents: number;
    }[];
    const pro = onBrand.find((p) => p.id === "p_pro")!;
    expect(pro.priceCents).toBe(3000);
    expect(pro.basePriceCents).toBe(1000);
    expect(pro.addonCents).toBe(2000);
    const platform = (await (await fetch(`${base}/api/billing/plans`)).json()) as {
      id: string;
      priceCents: number;
    }[];
    expect(platform.find((p) => p.id === "p_pro")?.priceCents).toBe(1000);
  });

  it("shows the brand admin an empty wallet and refuses a payout with nothing to pay", async () => {
    const admin = await login(BRAND_ADMIN);
    const wallet = await authed(admin.body.token, "/api/admin/brand/wallet");
    expect(wallet.status).toBe(200);
    expect(await wallet.json()).toEqual({ balances: [], entries: [] });

    const superAdmin = await login(SUPER);
    const view = await authed(superAdmin.body.token, "/api/super/brands/b_acme/wallet");
    expect(view.status).toBe(200);
    const payout = await authed(superAdmin.body.token, "/api/super/brands/b_acme/wallet/payouts", {
      method: "POST",
      body: JSON.stringify({ amountCents: 500, currency: "usd", reference: "TRF-1" }),
    });
    expect(payout.status).toBe(400);
    expect(((await payout.json()) as { error: string }).error).toMatch(/more than the wallet holds/);
  });
});

/* -------------------------- The platform's own team ----------------------- */

describe("the platform's own team", () => {
  // Every account belongs to a brand except the platform's own people: the
  // super admin, and the support staff they employ. So the super admin CAN add
  // staff — they land with no brand — but not resellers, which are a brand's
  // programme.
  let superToken = "";
  let brandToken = "";

  beforeAll(async () => {
    superToken = (await login(SUPER)).body.token;
    brandToken = (await login(BRAND_ADMIN)).body.token;
  });

  const fresh = { email: "fresh@example.com", fullName: "Fresh Person", password: "Passw0rd!" };

  it("lets the super admin add platform staff, who belong to no brand", async () => {
    const res = await authed(superToken, "/api/admin/staff", {
      method: "POST",
      body: JSON.stringify({ ...fresh, email: "platform-staff@example.com" }),
    });
    expect([200, 201]).toContain(res.status);
    const row = db.state.users.find((u) => u.email === "platform-staff@example.com");
    expect(row).toBeTruthy();
    expect(row!.brandId ?? null).toBeNull();
  });

  it("refuses the super admin a reseller — a brand runs its own programme", async () => {
    const res = await authed(superToken, "/api/admin/resellers", {
      method: "POST",
      body: JSON.stringify({ ...fresh, commissionPercent: 10 }),
    });
    expect([400, 403]).toContain(res.status);
    expect(((await res.json()) as { error: string }).error).toMatch(/brand/i);
  });

  it("offers each team only its own inbox in the permission matrix", async () => {
    type Matrix = { sections: { key: string }[] };
    const keys = (m: Matrix) => m.sections.map((s) => s.key);
    const platform = (await (await authed(superToken, "/api/admin/permissions")).json()) as Matrix;
    const brand = (await (await authed(brandToken, "/api/admin/permissions")).json()) as Matrix;
    expect(keys(platform)).toContain("brand_tickets");
    expect(keys(platform)).not.toContain("tickets");
    expect(keys(brand)).toContain("tickets");
    expect(keys(brand)).not.toContain("brand_tickets");
  });
});

/* ------------------------ Departments are the platform's ------------------ */

describe("departments are the platform's call", () => {
  let superToken = "";
  let brandToken = "";

  beforeAll(async () => {
    superToken = (await login(SUPER)).body.token;
    brandToken = (await login(BRAND_ADMIN)).body.token;
  });

  it("refuses a brand admin a new department of their own", async () => {
    const res = await authed(brandToken, "/api/admin/tickets/departments", {
      method: "POST",
      body: JSON.stringify({ name: "Refunds" }),
    });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toMatch(/set up by the platform/i);
  });

  it("refuses a brand admin renaming one, while still letting them staff it", async () => {
    // Renaming is refused up front (403) — before the row is even looked up.
    // Membership alone gets through to the lookup, which is a 404 here only
    // because the stand-in database holds no departments.
    const rename = await authed(brandToken, "/api/admin/tickets/departments/d_missing", {
      method: "PATCH",
      body: JSON.stringify({ name: "Refunds" }),
    });
    expect(rename.status).toBe(403);
    const staffing = await authed(brandToken, "/api/admin/tickets/departments/d_missing", {
      method: "PATCH",
      body: JSON.stringify({ staffIds: [] }),
    });
    expect(staffing.status).toBe(404);
  });

  it("gives the super admin a brand's departments from that brand's page", async () => {
    const res = await authed(superToken, "/api/super/brands/b_acme/ticket-departments");
    expect(res.status).toBe(200);
    expect(Array.isArray(await res.json())).toBe(true);
  });

  it("keeps a brand's page off-limits to the brand's own admin", async () => {
    const res = await authed(brandToken, "/api/super/brands/b_acme/ticket-departments");
    expect(res.status).toBe(403);
  });
});

/* ------------------------------ Sign-in by door --------------------------- */

describe("sign-in is by door", () => {
  // A brand's people live in the brand's own database, and that is what its
  // door reads. The platform's own door serves only the platform's own people.
  it("refuses a brand's admin on the platform's own door, and says where to go", async () => {
    const { status, body } = await login(BRAND_ADMIN, null);
    expect(status).toBe(403);
    const out = body as unknown as { error: string; details?: string };
    expect(out.details).toBe("wrong_door");
    expect(out.error).toMatch(/Acme Voice/);
  });

  it("signs a brand's admin in on their own door, with a session that names that database", async () => {
    const { status, body } = await login(BRAND_ADMIN, "acme");
    expect(status).toBe(200);
    const me = await authed(body.token, "/api/auth/me");
    expect(me.status).toBe(200);
    expect(((await me.json()) as { user: { brandId: string } }).user.brandId).toBe("b_acme");
  });

  it("lets the platform's own people sign in on a brand's door — the super admin helping inside", async () => {
    const { status, body } = await login(SUPER, "acme");
    expect(status).toBe(200);
    expect((body.user as unknown as { brandId: string | null }).brandId).toBeNull();
  });

  it("answers an unknown email on a brand's door with a plain 401", async () => {
    const { status } = await login({ email: "nobody@acmevoice.com", password: "x" }, "acme");
    expect(status).toBe(401);
  });

  it("scopes a password reset to the door as well", async () => {
    const res = await fetch(`${base}/api/auth/forgot-password`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: BRAND_ADMIN.email }),
    });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { details?: string }).details).toBe("wrong_door");
  });
});
