import { describe, it, expect, vi, beforeEach } from "vitest";

// Rollup reads each tenant and writes Main, skipping an unreadable tenant without losing
// the others; the overview is built from Main ALONE — no tenant is opened to draw it.

const h = vi.hoisted(() => ({
  tenants: [] as { brandId: string; db: unknown }[],
  activeIds: [] as string[],
  main: {
    brandStatsDaily: {
      upsert: vi.fn(async (_args?: unknown) => ({}) as unknown),
      count: vi.fn(async (_args?: unknown) => 0),
      findMany: vi.fn(async (_args?: unknown) => [] as unknown[]),
      groupBy: vi.fn(async (_args?: unknown) => [] as unknown[]),
    },
    brand: { findMany: vi.fn(async (_args?: unknown) => [] as unknown[]) },
    brandDatabase: { groupBy: vi.fn(async (_args?: unknown) => [] as unknown[]) },
    stripeUnroutedEvent: { count: vi.fn(async (_args?: unknown) => 0) },
  },
  ledgerSummary: vi.fn(async (_opts?: unknown) => ({ totals: [] as unknown[], byBrand: [] as unknown[] })),
  walletBalancesFor: vi.fn(async (_ids?: unknown) => new Map<string, { currency: string; balanceCents: number }[]>()),
  allTenants: vi.fn(async () => h.tenants),
}));

vi.mock("../prisma.js", () => ({ prisma: h.main }));
vi.mock("./tenantDb.js", () => ({
  allTenants: h.allTenants,
  activeTenantIds: async () => h.activeIds,
}));
vi.mock("./platformLedger.js", () => ({ ledgerSummary: h.ledgerSummary }));
vi.mock("./brandWallet.js", () => ({ walletBalancesFor: h.walletBalancesFor }));

const {
  utcDay,
  previousUtcDay,
  msUntilNextUtc,
  measureBrand,
  rollupBrandStats,
  catchUpBrandStats,
  platformOverview,
} = await import("./brandStats.js");

/** A tenant stand-in that answers the rollup's seven reads. */
function fakeTenant(n: {
  customers: number;
  active: number;
  trialing: number;
  callsTotal: number;
  seconds: number;
  open: number;
  dayCalls: number;
  daySeconds: number;
}) {
  const db = {
    user: { count: vi.fn(async () => n.customers) },
    profile: {
      count: vi.fn(async ({ where }: { where: { subscriptionStatus: unknown } }) =>
        JSON.stringify(where.subscriptionStatus).includes("trialing") ? n.trialing : n.active,
      ),
      aggregate: vi.fn(async () => ({ _sum: { trialSecondsUsed: n.seconds / 2, planSecondsUsed: n.seconds / 2 } })),
    },
    callLog: {
      count: vi.fn(async () => n.callsTotal),
      aggregate: vi.fn(async (_args?: unknown) => ({ _count: { _all: n.dayCalls }, _sum: { durationSec: n.daySeconds } })),
    },
    ticket: { count: vi.fn(async (_args?: unknown) => n.open) },
  };
  return db;
}

beforeEach(() => {
  vi.clearAllMocks();
  h.tenants.length = 0;
  h.activeIds.length = 0;
  h.main.brandStatsDaily.count.mockResolvedValue(0);
  h.main.brandStatsDaily.findMany.mockResolvedValue([]);
  h.main.brandStatsDaily.groupBy.mockResolvedValue([]);
  h.main.brand.findMany.mockResolvedValue([]);
  h.main.brandDatabase.groupBy.mockResolvedValue([]);
  h.main.stripeUnroutedEvent.count.mockResolvedValue(0);
  h.walletBalancesFor.mockResolvedValue(new Map());
  h.ledgerSummary.mockResolvedValue({ totals: [], byBrand: [] });
});

describe("days", () => {
  it("names a UTC calendar day and the one before it", () => {
    const at = new Date("2026-09-08T23:30:00Z");
    expect(utcDay(at).toISOString()).toBe("2026-09-08T00:00:00.000Z");
    expect(previousUtcDay(at).toISOString()).toBe("2026-09-07T00:00:00.000Z");
  });

  it("finds tonight's run, or tomorrow's when tonight has passed", () => {
    expect(msUntilNextUtc(0, 15, new Date("2026-09-08T00:00:00Z"))).toBe(15 * 60_000);
    expect(msUntilNextUtc(0, 15, new Date("2026-09-08T00:15:00Z"))).toBe(24 * 3_600_000);
  });
});

describe("measuring one brand", () => {
  it("reads customers, subscriptions, tickets and calls from the brand's database, for the day asked", async () => {
    const db = fakeTenant({ customers: 40, active: 12, trialing: 5, callsTotal: 900, seconds: 7200, open: 3, dayCalls: 14, daySeconds: 630 });
    const stats = await measureBrand(db as never, new Date("2026-09-07T13:00:00Z"));
    expect(stats).toEqual({
      customers: 40,
      active: 12,
      trialing: 5,
      callsTotal: 900,
      minutesTotal: 120,
      openTickets: 3,
      calls: 14,
      minutes: 10.5,
    });
    expect(db.user.count).toHaveBeenCalledWith({ where: { role: "USER" } });
    expect(db.ticket.count.mock.calls[0][0]).toMatchObject({ where: { lane: "support" } });
    // The per-day window is the UTC day, half-open.
    const window = (db.callLog.aggregate.mock.calls[0][0] as { where: { createdAt: { gte: Date; lt: Date } } }).where.createdAt;
    expect(window.gte.toISOString()).toBe("2026-09-07T00:00:00.000Z");
    expect(window.lt.toISOString()).toBe("2026-09-08T00:00:00.000Z");
  });
});

describe("rolling every brand up", () => {
  it("writes one row per brand per day, and a brand that cannot be read is reported, not fatal", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const good = fakeTenant({ customers: 1, active: 1, trialing: 0, callsTotal: 2, seconds: 60, open: 0, dayCalls: 1, daySeconds: 30 });
    const broken = { user: { count: vi.fn(async () => { throw new Error("connection refused"); }) } };
    h.tenants.push({ brandId: "b_good", db: good }, { brandId: "b_broken", db: broken });

    const result = await rollupBrandStats(new Date("2026-09-07T10:00:00Z"));

    expect(result).toEqual({ day: "2026-09-07", brands: 1, failed: ["b_broken"] });
    expect(h.main.brandStatsDaily.upsert).toHaveBeenCalledTimes(1);
    expect(h.main.brandStatsDaily.upsert.mock.calls[0][0]).toMatchObject({
      where: { brandId_day: { brandId: "b_good", day: new Date("2026-09-07T00:00:00Z") } },
      create: expect.objectContaining({ brandId: "b_good", customers: 1, calls: 1, minutes: 0.5 }),
    });
    warn.mockRestore();
  });

  it("catches up last night only when a brand's row is missing", async () => {
    h.activeIds.push("b_1", "b_2");
    h.main.brandStatsDaily.count.mockResolvedValue(2);
    expect(await catchUpBrandStats()).toBeNull();
    expect(h.allTenants).not.toHaveBeenCalled();

    h.main.brandStatsDaily.count.mockResolvedValue(1);
    const r = await catchUpBrandStats();
    expect(r).not.toBeNull();
    expect(h.allTenants).toHaveBeenCalledTimes(1);
  });
});

describe("the overview", () => {
  it("is built from Main alone: rollup rows, ledger, wallets, parked events — no tenant opened", async () => {
    const now = new Date("2026-09-08T09:00:00Z");
    h.main.brand.findMany.mockResolvedValue([
      { id: "b_acme", name: "Acme", slug: "acme", status: "active" },
      { id: "b_globex", name: "Globex", slug: "globex", status: "active" },
      { id: "b_new", name: "Newco", slug: "newco", status: "provisioning" },
    ]);
    h.main.brandStatsDaily.findMany.mockResolvedValue([
      // Last night's row: fresh.
      { brandId: "b_acme", day: new Date("2026-09-07T00:00:00Z"), computedAt: new Date("2026-09-08T00:15:00Z"), customers: 40, active: 12, trialing: 5, callsTotal: 900, minutesTotal: 120, openTickets: 3, calls: 14, minutes: 10.5 },
      // Three days old: the job skipped this brand — stale, but its numbers still count.
      { brandId: "b_globex", day: new Date("2026-09-05T00:00:00Z"), computedAt: new Date("2026-09-06T00:15:00Z"), customers: 10, active: 2, trialing: 1, callsTotal: 50, minutesTotal: 9, openTickets: 1, calls: 2, minutes: 1 },
    ]);
    h.main.brandStatsDaily.groupBy.mockResolvedValue([
      { day: new Date("2026-09-06T00:00:00Z"), _sum: { calls: 20, minutes: 15.25 } },
      { day: new Date("2026-09-07T00:00:00Z"), _sum: { calls: 16, minutes: 11.5 } },
    ]);
    h.main.brandDatabase.groupBy.mockResolvedValue([
      { status: "active", _count: { _all: 2 } },
      { status: "provisioning", _count: { _all: 1 } },
    ]);
    h.main.stripeUnroutedEvent.count.mockResolvedValue(1);
    h.ledgerSummary.mockResolvedValue({
      totals: [{ currency: "usd", payments: 3, totalCents: 22500, platformCents: 15000, brandCents: 7500, refundedCents: 0 }],
      byBrand: [],
    });
    h.walletBalancesFor.mockResolvedValue(
      new Map([
        ["b_acme", [{ currency: "usd", balanceCents: 5000 }]],
        ["b_globex", [{ currency: "usd", balanceCents: 2500 }, { currency: "eur", balanceCents: 100 }]],
      ]),
    );

    const o = await platformOverview(now);

    expect(h.allTenants).not.toHaveBeenCalled();
    expect(o.asOf).toBe("2026-09-08T00:15:00.000Z");
    expect(o.brands).toEqual({ total: 3, active: 2, provisioning: 1, failed: 0, suspended: 0 });
    expect(o.tenants).toEqual({ active: 2, provisioning: 1 });
    expect(o.totals).toEqual({ customers: 50, active: 14, trialing: 6, callsTotal: 950, minutesTotal: 129, openTickets: 4 });
    expect(o.perBrand.map((b) => [b.slug, b.day, b.stale])).toEqual([
      ["acme", "2026-09-07", false],
      ["globex", "2026-09-05", true],
      ["newco", null, true],
    ]);
    expect(o.series).toEqual([
      { day: "2026-09-06", calls: 20, minutes: 15.3 },
      { day: "2026-09-07", calls: 16, minutes: 11.5 },
    ]);
    expect(o.ledger.from).toBe("2026-09-01T00:00:00.000Z");
    expect(o.ledger.totals[0]).toMatchObject({ currency: "usd", totalCents: 22500 });
    expect(o.wallets).toEqual([
      { currency: "usd", balanceCents: 7500 },
      { currency: "eur", balanceCents: 100 },
    ]);
    expect(o.unroutedEvents).toBe(1);
    // The ledger window is this month, up to now.
    expect(h.ledgerSummary).toHaveBeenCalledWith({ from: new Date("2026-09-01T00:00:00Z"), to: now });
  });
});
