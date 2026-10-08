import type { Brand } from "@prisma/client";
import { prisma } from "../prisma.js";
import { DAY_MS, dayKey, utcDay } from "./brandStats.js";

// One brand's analytics for the super admin. Everything here is read from Main — the nightly stats
// rollup and the platform ledger — so the page opens no tenant database and costs a handful of indexed queries.

export interface BrandAnalyticsDay {
  day: string;
  calls: number;
  minutes: number;
  customers: number;
  active: number;
  /** What the brand's customers paid that day, in `currency` (gross of refunds). */
  revenueCents: number;
  /** The platform's share of it. */
  platformCents: number;
}

export interface BrandAnalytics {
  days: number;
  /** The currency revenue figures are in: the one this brand's customers paid most in. */
  currency: string;
  series: BrandAnalyticsDay[];
  totals: { calls: number; minutes: number; revenueCents: number; platformCents: number; brandCents: number };
  /** As of the latest nightly rollup. */
  current: {
    customers: number;
    active: number;
    trialing: number;
    openTickets: number;
    callsTotal: number;
    minutesTotal: number;
    asOf: string | null;
  };
}

export async function brandAnalytics(brand: Brand, days: number, now: Date = new Date()): Promise<BrandAnalytics> {
  const today = utcDay(now);
  const from = new Date(today.getTime() - (days - 1) * DAY_MS);

  const [stats, latest, ledger] = await Promise.all([
    prisma.brandStatsDaily.findMany({ where: { brandId: brand.id, day: { gte: from } }, orderBy: { day: "asc" } }),
    prisma.brandStatsDaily.findFirst({ where: { brandId: brand.id }, orderBy: { day: "desc" } }),
    prisma.$queryRaw<{ day: Date; currency: string; total: bigint; platform: bigint; brand: bigint }[]>`
      SELECT date_trunc('day', "paidAt") AS day, "currency",
             SUM("totalCents")::bigint AS total, SUM("platformCents")::bigint AS platform,
             SUM("brandCents")::bigint AS brand
      FROM "platform_ledger"
      WHERE "brandId" = ${brand.id} AND "paidAt" >= ${from}
      GROUP BY 1, 2`,
  ]);

  // Revenue in one currency: whichever carried the most money in the window (a brand usually has one).
  const byCurrency = new Map<string, number>();
  for (const r of ledger) byCurrency.set(r.currency, (byCurrency.get(r.currency) ?? 0) + Number(r.total));
  const currency = [...byCurrency.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "usd";

  const statsByDay = new Map(stats.map((s) => [dayKey(s.day), s]));
  const moneyByDay = new Map<string, { revenue: number; platform: number; brand: number }>();
  for (const r of ledger) {
    if (r.currency !== currency) continue;
    const key = dayKey(r.day);
    const m = moneyByDay.get(key) ?? { revenue: 0, platform: 0, brand: 0 };
    m.revenue += Number(r.total);
    m.platform += Number(r.platform);
    m.brand += Number(r.brand);
    moneyByDay.set(key, m);
  }

  // Zero-filled, so a quiet day reads as zero instead of a gap in the chart.
  const series: BrandAnalyticsDay[] = [];
  let lastCustomers = 0;
  let lastActive = 0;
  for (let t = from.getTime(); t <= today.getTime(); t += DAY_MS) {
    const key = dayKey(new Date(t));
    const s = statsByDay.get(key);
    const m = moneyByDay.get(key);
    // Headcounts are snapshots: carry the last known value across days the rollup hasn't reached.
    if (s) {
      lastCustomers = s.customers;
      lastActive = s.active;
    }
    series.push({
      day: key,
      calls: s?.calls ?? 0,
      minutes: Math.round(s?.minutes ?? 0),
      customers: lastCustomers,
      active: lastActive,
      revenueCents: m?.revenue ?? 0,
      platformCents: m?.platform ?? 0,
    });
  }

  const totals = series.reduce(
    (acc, d) => ({
      calls: acc.calls + d.calls,
      minutes: acc.minutes + d.minutes,
      revenueCents: acc.revenueCents + d.revenueCents,
      platformCents: acc.platformCents + d.platformCents,
      brandCents: acc.brandCents,
    }),
    { calls: 0, minutes: 0, revenueCents: 0, platformCents: 0, brandCents: 0 },
  );
  totals.brandCents = [...moneyByDay.values()].reduce((sum, m) => sum + m.brand, 0);

  return {
    days,
    currency,
    series,
    totals,
    current: {
      customers: latest?.customers ?? 0,
      active: latest?.active ?? 0,
      trialing: latest?.trialing ?? 0,
      openTickets: latest?.openTickets ?? 0,
      callsTotal: latest?.callsTotal ?? 0,
      minutesTotal: Math.round(latest?.minutesTotal ?? 0),
      asOf: latest?.computedAt.toISOString() ?? null,
    },
  };
}
