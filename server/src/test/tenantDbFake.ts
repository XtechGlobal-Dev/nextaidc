/* ------------------------------------------------------------------ *
 *  A stand-in for services/tenantDb.js in unit tests.
 *
 *  Since phase 6 a customer's profile, agent record, calls and coupons
 *  are read from the brand's own database. Tests that fake `prisma`
 *  model by model keep working by letting the brand's database BE that
 *  same fake: every router in here resolves to one object that answers
 *  from `extras` first (models the test names explicitly) and from the
 *  mocked control-plane client otherwise.
 *
 *  Use inside a vi.mock factory:
 *
 *    vi.mock("../services/tenantDb.js", async () =>
 *      (await import("../test/tenantDbFake.js")).tenantDbFake({ callLog: { ... } }),
 *    );
 * ------------------------------------------------------------------ */

export async function tenantDbFake(
  extras: Record<string, unknown> = {},
  brandId = "b_acme",
  /** Routers a test wants to observe or script itself (e.g. `callDb: h.callDb`). */
  overrides: Record<string, unknown> = {},
) {
  const { prisma } = await import("../prisma.js");
  const control = prisma as unknown as Record<string | symbol, unknown>;
  const db = new Proxy(extras, {
    get(target, key) {
      if (key in target) return target[key as string];
      return control[key];
    },
  });

  class TenantUnavailableError extends Error {
    constructor(
      public brandId = "",
      public status = "none",
    ) {
      super(`Brand ${brandId}'s database is not available (status: ${status}).`);
    }
  }
  class TenantMismatchError extends Error {}
  class CrossDatabaseQueryError extends Error {}

  const one = async () => db;
  const list = async () => [{ brandId, db }];
  return {
    tenantFor: one,
    tenantForUser: one,
    requestTenant: one,
    currentTenant: one,
    planeOf: one,
    laneDb: one,
    callDb: one,
    currentCallDb: one,
    controlPlaneAsTenant: () => prisma,
    allTenants: list,
    allCallDbs: list,
    tenantsFor: list,
    activeTenantIds: async () => [brandId],
    tenantStatus: async () => "active",
    invalidateTenantRegistry: () => {},
    disconnectTenantDbs: async () => {},
    assertRoutable: () => {},
    TenantUnavailableError,
    TenantMismatchError,
    CrossDatabaseQueryError,
    ...overrides,
  };
}
