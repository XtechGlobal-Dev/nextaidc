import type { BrandStatsDaily } from "@prisma/client";
import { prisma } from "../prisma.js";
import { allTenants, activeTenantIds, type TenantClient } from "./tenantDb.js";
import { ledgerSummary, type LedgerTotals } from "./platformLedger.js";
import { walletBalancesFor } from "./brandWallet.js";

// Brand stats rollup (plan §7). A nightly job writes one row per brand into Main (brand_stats_daily)
// so the super admin's overview never opens N tenant databases to draw a page. Numbers are "as of last night".

export const DAY_MS = 86_400_000;

/** Statuses that count as a live, paying subscription — same reading as the
 *  brand admin's own overview. */
export const ACTIVE_SUB_STATUSES = ["active", "past_due"];
export const OPEN_TICKET_STATUSES = ["open", "pending"] as const;

/** Midnight UTC of the calendar day `d` falls in. */
export function utcDay(d: Date = new Date()): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

/** The UTC day before the one `d` falls in — what "last night" rolled up. */
export function previousUtcDay(d: Date = new Date()): Date {
  return new Date(utcDay(d).getTime() - DAY_MS);
}

export function dayKey(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** Milliseconds until the next hh:mm UTC — how the scheduler finds "tonight". */
export function msUntilNextUtc(hour: number, minute: number, now: Date = new Date()): number {
  const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), hour, minute));
  if (next.getTime() <= now.getTime()) next.setUTCDate(next.getUTCDate() + 1);
  return next.getTime() - now.getTime();
}

export interface BrandDayStats {
  /** Snapshot as of the run. */
  customers: number;
  active: number;
  trialing: number;
  callsTotal: number;
  minutesTotal: number;
  openTickets: number;
  /** What happened on the day being rolled up. */
  calls: number;
  minutes: number;
}

/** Everything the rollup keeps about one brand, read from that brand's database. */
export async function measureBrand(db: TenantClient, day: Date): Promise<BrandDayStats> {
  const from = utcDay(day);
  const to = new Date(from.getTime() + DAY_MS);
  const [customers, active, trialing, callsTotal, usage, openTickets, onDay] = await Promise.all([
    db.user.count({ where: { role: "USER" } }),
    db.profile.count({ where: { subscriptionStatus: { in: ACTIVE_SUB_STATUSES } } }),
    db.profile.count({ where: { subscriptionStatus: "trialing" } }),
    db.callLog.count(),
    db.profile.aggregate({ _sum: { trialSecondsUsed: true, planSecondsUsed: true } }),
    db.ticket.count({ where: { lane: "support", status: { in: [...OPEN_TICKET_STATUSES] } } }),
    db.callLog.aggregate({
      where: { createdAt: { gte: from, lt: to } },
      _count: { _all: true },
      _sum: { durationSec: true },
    }),
  ]);
  const secondsTotal = (usage._sum.trialSecondsUsed ?? 0) + (usage._sum.planSecondsUsed ?? 0);
  return {
    customers,
    active,
    trialing,
    callsTotal,
    minutesTotal: Math.round(secondsTotal / 60),
    openTickets,
    calls: onDay._count._all,
    minutes: Math.round(((onDay._sum.durationSec ?? 0) / 60) * 10) / 10,
  };
}

export interface RollupResult {
  day: string;
  brands: number;
  failed: string[];
}

/** Writes each active tenant's row for `day`. An unreadable tenant is skipped and keeps its previous row, so it shows as stale rather than zero. */
export async function rollupBrandStats(day: Date = previousUtcDay()): Promise<RollupResult> {
  const key = utcDay(day);
  const failed: string[] = [];
  let brands = 0;
  for (const { brandId, db } of await allTenants()) {
    try {
      const stats = await measureBrand(db, key);
      await prisma.brandStatsDaily.upsert({
        where: { brandId_day: { brandId, day: key } },
        create: { brandId, day: key, ...stats, computedAt: new Date() },
        update: { ...stats, computedAt: new Date() },
      });
      brands += 1;
    } catch (e) {
      failed.push(brandId);
      console.warn(
        `[brand-stats] ${brandId}: could not roll up ${dayKey(key)}:`,
        e instanceof Error ? e.message : e,
      );
    }
  }
  return { day: dayKey(key), brands, failed };
}

/** At boot: if last night's run was missed (process down across midnight), run it now. */
export async function catchUpBrandStats(): Promise<RollupResult | null> {
  const yesterday = previousUtcDay();
  const [have, want] = await Promise.all([
    prisma.brandStatsDaily.count({ where: { day: yesterday } }),
    activeTenantIds(),
  ]);
  if (have >= want.length) return null;
  return rollupBrandStats(yesterday);
}

/* ------------------------------ Overview ------------------------------ */

export interface PlatformBrandRow extends BrandDayStats {
  brandId: string;
  name: string;
  slug: string;
  status: string;
  /** The day the per-day numbers describe; null when the brand has never been rolled up. */
  day: string | null;
  computedAt: string | null;
  /** True when the newest row is older than last night's — the job skipped
   *  this brand, or the brand's database was not reachable. */
  stale: boolean;
}

export interface PlatformOverview {
  /** Newest computedAt across the rows shown; null until the first rollup. */
  asOf: string | null;
  brands: { total: number; active: number; provisioning: number; failed: number; suspended: number };
  tenants: Record<string, number>;
  totals: Omit<BrandDayStats, "calls" | "minutes">;
  perBrand: PlatformBrandRow[];
  /** Per-day platform totals for the last two weeks, oldest first. */
  series: { day: string; calls: number; minutes: number }[];
  ledger: { from: string; to: string; totals: LedgerTotals[] };
  wallets: { currency: string; balanceCents: number }[];
  unroutedEvents: number;
}

const EMPTY: BrandDayStats = {
  customers: 0,
  active: 0,
  trialing: 0,
  callsTotal: 0,
  minutesTotal: 0,
  openTickets: 0,
  calls: 0,
  minutes: 0,
};

function statsOf(r: BrandStatsDaily | undefined): BrandDayStats {
  if (!r) return EMPTY;
  return {
    customers: r.customers,
    active: r.active,
    trialing: r.trialing,
    callsTotal: r.callsTotal,
    minutesTotal: r.minutesTotal,
    openTickets: r.openTickets,
    calls: r.calls,
    minutes: r.minutes,
  };
}

/** The super admin's overview, from Main alone — no tenant is opened to build it. */
export async function platformOverview(now: Date = new Date()): Promise<PlatformOverview> {
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const since = new Date(utcDay(now).getTime() - 13 * DAY_MS);
  const yesterday = previousUtcDay(now);

  const [brands, latest, byDay, tenantRows, ledger, unroutedEvents] = await Promise.all([
    prisma.brand.findMany({
      select: { id: true, name: true, slug: true, status: true },
      orderBy: { name: "asc" },
    }),
    // Newest row per brand — the snapshot the overview is "as of".
    prisma.brandStatsDaily.findMany({ distinct: ["brandId"], orderBy: [{ brandId: "asc" }, { day: "desc" }] }),
    prisma.brandStatsDaily.groupBy({
      by: ["day"],
      where: { day: { gte: since } },
      _sum: { calls: true, minutes: true },
      orderBy: { day: "asc" },
    }),
    prisma.brandDatabase.groupBy({ by: ["status"], _count: { _all: true } }),
    ledgerSummary({ from: monthStart, to: now }),
    prisma.stripeUnroutedEvent.count({ where: { resolvedAt: null } }),
  ]);
  const wallets = await walletBalancesFor(brands.map((b) => b.id));

  const latestBy = new Map(latest.map((r) => [r.brandId, r]));
  const perBrand: PlatformBrandRow[] = brands.map((b) => {
    const r = latestBy.get(b.id);
    return {
      brandId: b.id,
      name: b.name,
      slug: b.slug,
      status: b.status,
      day: r ? dayKey(r.day) : null,
      computedAt: r ? r.computedAt.toISOString() : null,
      stale: !r || r.day.getTime() < yesterday.getTime(),
      ...statsOf(r),
    };
  });

  const totals = perBrand.reduce(
    (acc, r) => ({
      customers: acc.customers + r.customers,
      active: acc.active + r.active,
      trialing: acc.trialing + r.trialing,
      callsTotal: acc.callsTotal + r.callsTotal,
      minutesTotal: acc.minutesTotal + r.minutesTotal,
      openTickets: acc.openTickets + r.openTickets,
    }),
    { customers: 0, active: 0, trialing: 0, callsTotal: 0, minutesTotal: 0, openTickets: 0 },
  );

  const brandCounts = { total: brands.length, active: 0, provisioning: 0, failed: 0, suspended: 0 };
  for (const b of brands) {
    if (b.status in brandCounts) brandCounts[b.status as keyof typeof brandCounts] += 1;
  }

  const walletTotals = new Map<string, number>();
  for (const balances of wallets.values()) {
    for (const w of balances) walletTotals.set(w.currency, (walletTotals.get(w.currency) ?? 0) + w.balanceCents);
  }

  let asOf: Date | null = null;
  for (const r of latest) if (!asOf || r.computedAt > asOf) asOf = r.computedAt;

  return {
    asOf: asOf ? asOf.toISOString() : null,
    brands: brandCounts,
    tenants: Object.fromEntries(tenantRows.map((t) => [t.status, t._count._all])),
    totals,
    perBrand,
    series: byDay.map((d) => ({
      day: dayKey(d.day),
      calls: d._sum.calls ?? 0,
      minutes: Math.round((d._sum.minutes ?? 0) * 10) / 10,
    })),
    ledger: { from: monthStart.toISOString(), to: now.toISOString(), totals: ledger.totals },
    wallets: [...walletTotals].map(([currency, balanceCents]) => ({ currency, balanceCents })),
    unroutedEvents,
  };
}
