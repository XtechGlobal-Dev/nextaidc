// Read side of the API Center: merges apiTrace, settings and providerStatus into one view.
// Health/uptime rules live here (not the browser) so every screen agrees. Costs are estimates, never billing truth.

import { prisma } from "../prisma.js";
import { allTenants } from "./tenantDb.js";
import {
  PROVIDER_DEFS,
  CATEGORY_LABEL,
  CATEGORY_ORDER,
  AUTH_LABEL,
  UNIT_LABEL,
  providerDefOrFallback,
  type ApiCategory,
  type ProviderDef,
} from "./apiProviders.js";
import { allSnapshots } from "./apiTrace.js";
import { getProviderStatuses, type ProviderIncident, type StatusIndicator } from "./providerStatus.js";
import { integrationsStatus } from "./settings.js";
import { isStripeConfigured } from "./stripe.js";
import { isTwilioConfigured } from "./sms.js";

/* ------------------------------ Ranges ----------------------------- */

export type RangeKey = "1h" | "24h" | "7d" | "30d";

interface RangeSpec {
  key: RangeKey;
  label: string;
  ms: number;
  /** Bucket width, chosen so every range renders 24-48 points — dense enough to
   *  show shape, sparse enough to stay readable at dashboard size. */
  bucketSec: number;
}

const RANGES: Record<RangeKey, RangeSpec> = {
  "1h": { key: "1h", label: "Last hour", ms: 60 * 60 * 1000, bucketSec: 120 },
  "24h": { key: "24h", label: "Last 24 hours", ms: 24 * 60 * 60 * 1000, bucketSec: 1800 },
  "7d": { key: "7d", label: "Last 7 days", ms: 7 * 24 * 60 * 60 * 1000, bucketSec: 21600 },
  "30d": { key: "30d", label: "Last 30 days", ms: 30 * 24 * 60 * 60 * 1000, bucketSec: 86400 },
};

export function resolveRange(key: string | undefined): RangeSpec {
  return RANGES[(key ?? "24h") as RangeKey] ?? RANGES["24h"];
}

/* ---------------------------- Thresholds --------------------------- */

/** Where "healthy" stops. Single source so the screens and default alert rules can't drift apart. */
export const THRESHOLDS = {
  /** Error rate (%) at which a provider is degraded / failed. */
  errorRateWarn: 5,
  errorRateFail: 25,
  /** p95 latency (ms) at which a provider is slow / very slow. */
  latencyWarnMs: 2_000,
  latencyFailMs: 6_000,
  /** Quota consumption (%) that is worth flagging. */
  quotaWarnPct: 80,
  quotaFailPct: 95,
  /** Rate-limit headroom (%) left before it's worth flagging. */
  rateHeadroomWarnPct: 20,
  /** Days before key expiry that counts as "expiring". */
  keyExpiryWarnDays: 30,
  // Under this many requests rates are noise (2 of 3 failing isn't a 67% outage); never mark failed on rate alone.
  minSampleForRates: 5,
} as const;

/* ------------------------------ Types ------------------------------ */

export type HealthState = "healthy" | "degraded" | "failed" | "disconnected" | "idle" | "not_configured";

export type AuthStatus = "ok" | "missing" | "expiring" | "expired" | "failing";

export interface SeriesPoint {
  /** Bucket start, ISO. */
  t: string;
  requests: number;
  errors: number;
  /** Vendor-side failures only (5xx, 429, transport) — the availability numerator. */
  vendorErrors: number;
  p50: number;
  p95: number;
  p99: number;
  avgMs: number;
  costUsd: number;
  units: number;
}

export interface ProviderRow {
  id: string;
  name: string;
  category: ApiCategory;
  categoryLabel: string;
  blurb: string;

  /* Connection */
  wired: boolean;
  connected: boolean;
  // Derived at runtime (differs per environment). Recorded traffic counts too, so a provider
  // whose key was removed keeps showing its failures instead of vanishing when it breaks.
  inUse: boolean;
  authMethod: string;
  authLabel: string;
  authStatus: AuthStatus;
  environment: string;
  apiVersion: string | null;
  keyExpiresAt: string | null;
  muted: boolean;

  /* Health */
  health: HealthState;
  attentionScore: number;
  attentionReasons: string[];

  /* Traffic over the selected window */
  requests: number;
  errors: number;
  successRate: number;
  errorRate: number;
  /** Vendor-side availability — excludes 4xx, which are our bug, not their outage. */
  uptimePct: number;
  requestsPerHour: number;
  requestsToday: number;
  requestsThisMonth: number;

  /* Latency */
  latencyP50: number;
  latencyP95: number;
  latencyP99: number;
  latencyAvg: number;

  /* Freshness */
  lastRequestAt: string | null;
  lastSuccessAt: string | null;
  lastErrorAt: string | null;
  lastErrorMessage: string;
  lastErrorStatus: number;

  /* Quota & limits */
  monthlyQuota: number;
  quotaUsed: number;
  quotaPct: number | null;
  rateLimitPerMin: number;
  rateLimit: number | null;
  rateRemaining: number | null;
  rateResetAt: string | null;

  /* Cost */
  costUsd: number;
  /** Calendar month to date — a different window from `costUsd`, because spend
   *  is a monthly concept and the range filter shouldn't change it. */
  costMonthUsd: number;
  costConfidence: ProviderDef["costConfidence"];
  unit: ProviderDef["unit"];
  unitLabel: string;
  unitCostUsd: number | null;
  units: number;

  /* Vendor-reported */
  incidentIndicator: StatusIndicator;
  incidentDescription: string;
  incidentCount: number;
  statusPageUrl: string | null;
  dashboardUrl: string | null;
  docsUrl: string;

  /* Webhooks */
  webhookDirection: ProviderDef["webhooks"] | null;
  webhookTotal: number;
  webhookFailed: number;
  webhookSuccessRate: number | null;

  // Per-bucket series on the shared x-axis, sent per provider so the browser can
  // rebuild charts/totals for any filtered subset (fleet-only totals looked broken when filtering).
  trend: {
    requests: number[];
    errors: number[];
    costUsd: number[];
    /** Traffic-weighted p95 for that bucket, 0 where the provider was idle. */
    p95: number[];
  };
}

/* --------------------------- Raw row shapes ------------------------ */

interface BucketRow {
  provider: string;
  bucket: number;
  total: number;
  errors: number;
  vendor_errors: number;
  auth_errors: number;
  cost_micro: number;
  units: number;
  p50: number;
  p95: number;
  p99: number;
  avg_ms: number;
}

interface MarkerRow {
  provider: string;
  last_request: Date | null;
  last_success: Date | null;
  last_error: Date | null;
}

interface LastErrorRow {
  provider: string;
  status: number;
  errorMessage: string;
}

interface RateRow {
  provider: string;
  rateLimit: number | null;
  rateRemaining: number | null;
  rateResetAt: Date | null;
}

interface MonthRow {
  provider: string;
  total: number;
  units: number;
  cost_micro: number;
}

interface TodayRow {
  provider: string;
  total: number;
}

/* --------------------------- Query helpers ------------------------- */

// One pass over the window, bucketed by provider and time. Percentiles are computed
// in Postgres — pulling raw durations to Node would ship the whole table.
async function bucketRows(from: Date, to: Date, bucketSec: number, environment?: string): Promise<BucketRow[]> {
  const rows = await prisma.$queryRaw<BucketRow[]>`
    SELECT
      "provider",
      (floor(extract(epoch FROM "createdAt") / ${bucketSec}) * ${bucketSec})::float8 AS bucket,
      count(*)::int AS total,
      count(*) FILTER (WHERE NOT "ok")::int AS errors,
      count(*) FILTER (WHERE NOT "ok" AND ("status" = 0 OR "status" >= 500 OR "status" = 429))::int AS vendor_errors,
      count(*) FILTER (WHERE "status" IN (401, 403))::int AS auth_errors,
      coalesce(sum("costMicroUsd"), 0)::float8 AS cost_micro,
      coalesce(sum("units"), 0)::float8 AS units,
      coalesce(percentile_cont(0.5) WITHIN GROUP (ORDER BY "durationMs"), 0)::float8 AS p50,
      coalesce(percentile_cont(0.95) WITHIN GROUP (ORDER BY "durationMs"), 0)::float8 AS p95,
      coalesce(percentile_cont(0.99) WITHIN GROUP (ORDER BY "durationMs"), 0)::float8 AS p99,
      coalesce(avg("durationMs"), 0)::float8 AS avg_ms
    FROM "api_request_logs"
    WHERE "createdAt" >= ${from}
      AND "createdAt" < ${to}
      AND (${environment ?? null}::text IS NULL OR "environment" = ${environment ?? null}::text)
    GROUP BY 1, 2
    ORDER BY 2 ASC
  `;
  return rows;
}

/** Last request / success / failure per provider, over all retained history —
 *  "last successful request" must stay true even for a vendor idle all week. */
async function markerRows(): Promise<MarkerRow[]> {
  return prisma.$queryRaw<MarkerRow[]>`
    SELECT
      "provider",
      max("createdAt")                          AS last_request,
      max("createdAt") FILTER (WHERE "ok")      AS last_success,
      max("createdAt") FILTER (WHERE NOT "ok")  AS last_error
    FROM "api_request_logs"
    GROUP BY "provider"
  `;
}

/** The most recent failure per provider, with its reason. */
async function lastErrorRows(): Promise<LastErrorRow[]> {
  return prisma.$queryRaw<LastErrorRow[]>`
    SELECT DISTINCT ON ("provider") "provider", "status", "errorMessage"
    FROM "api_request_logs"
    WHERE NOT "ok"
    ORDER BY "provider", "createdAt" DESC
  `;
}

/** Newest response that carried rate-limit headers, per provider. */
async function rateRows(): Promise<RateRow[]> {
  return prisma.$queryRaw<RateRow[]>`
    SELECT DISTINCT ON ("provider") "provider", "rateLimit", "rateRemaining", "rateResetAt"
    FROM "api_request_logs"
    WHERE "rateRemaining" IS NOT NULL
    ORDER BY "provider", "createdAt" DESC
  `;
}

// Month-to-date totals (quota is calendar-month, independent of the range filter).
// Must take the environment filter too, or the quota meter disagrees with the rest of the row.
async function monthRows(monthStart: Date, environment?: string): Promise<MonthRow[]> {
  return prisma.$queryRaw<MonthRow[]>`
    SELECT
      "provider",
      count(*)::int AS total,
      coalesce(sum("units"), 0)::float8 AS units,
      coalesce(sum("costMicroUsd"), 0)::float8 AS cost_micro
    FROM "api_request_logs"
    WHERE "createdAt" >= ${monthStart}
      AND (${environment ?? null}::text IS NULL OR "environment" = ${environment ?? null}::text)
    GROUP BY "provider"
  `;
}

async function todayRows(dayStart: Date, environment?: string): Promise<TodayRow[]> {
  return prisma.$queryRaw<TodayRow[]>`
    SELECT "provider", count(*)::int AS total
    FROM "api_request_logs"
    WHERE "createdAt" >= ${dayStart}
      AND (${environment ?? null}::text IS NULL OR "environment" = ${environment ?? null}::text)
    GROUP BY "provider"
  `;
}

/* ---------------------------- Derivation --------------------------- */

function pct(part: number, whole: number): number {
  if (whole <= 0) return 0;
  return Math.round((part / whole) * 1000) / 10;
}

function isoOrNull(d: Date | null | undefined): string | null {
  return d ? d.toISOString() : null;
}

/** Does this deployment use the provider? Live state, not a static list (differs per env); the lastRequestAt clause keeps a provider with a removed key visible with its failures. */
export function isProviderInUse(input: {
  /** The code has a call site for this vendor. */
  wired: boolean;
  /** We hold usable credentials for it. */
  connected: boolean;
  /** Requests in the selected window. */
  requests: number;
  /** Newest request ever recorded, across all retained history. */
  lastRequestAt: Date | null;
}): boolean {
  return input.wired && (input.connected || input.requests > 0 || input.lastRequestAt !== null);
}

/** Which providers hold usable credentials right now. */
function connectionMap(): Map<string, boolean> {
  const integrations = integrationsStatus();
  const map = new Map<string, boolean>();
  for (const def of PROVIDER_DEFS) {
    if (def.id === "stripe") map.set(def.id, isStripeConfigured());
    else if (def.id === "twilio") map.set(def.id, isTwilioConfigured());
    // Not a vendor we hold a key for — it's this platform's own API.
    else if (def.id === "self") map.set(def.id, true);
    // Customer-configured outbound endpoints: connected as a capability.
    else if (def.id === "webhook") map.set(def.id, true);
    else if (def.integrationId) map.set(def.id, integrations[def.integrationId] === true);
    else map.set(def.id, false);
  }
  return map;
}

/** One provider's window totals, folded from its buckets. */
interface ProviderAgg {
  requests: number;
  errors: number;
  vendorErrors: number;
  authErrors: number;
  costMicro: number;
  units: number;
  p50: number;
  p95: number;
  p99: number;
  avgMs: number;
  /** Per-bucket arrays, all aligned to the shared timeline. */
  trend: ProviderRow["trend"];
}

interface DeriveInput {
  def: ProviderDef;
  connected: boolean;
  setting: {
    monthlyQuota: number;
    unitCostMicroUsd: number | null;
    rateLimitPerMin: number;
    environment: string;
    keyExpiresAt: Date | null;
    muted: boolean;
  } | null;
  agg: ProviderAgg;
  marker: MarkerRow | undefined;
  lastError: LastErrorRow | undefined;
  rate: RateRow | undefined;
  month: MonthRow | undefined;
  todayCount: number;
  incident: { indicator: StatusIndicator; description: string; count: number } | undefined;
  webhook: { total: number; failed: number } | undefined;
  windowHours: number;
}

// Builds one provider card. uptimePct counts only vendor-side failures (5xx/429/transport) —
// a 401/422 is our bug, not their outage. Tiny samples never escalate to failed (minSampleForRates).
function deriveRow(input: DeriveInput): ProviderRow {
  const { def, connected, setting, agg, marker, lastError, rate, month, incident, webhook } = input;

  const snapshot = allSnapshots().get(def.id) ?? null;
  const environment = setting?.environment ?? "production";
  const muted = setting?.muted ?? false;
  const keyExpiresAt = setting?.keyExpiresAt ?? null;

  /* --- rates --- */
  const requests = agg.requests;
  const errors = agg.errors;
  const errorRate = pct(errors, requests);
  const successRate = requests > 0 ? Math.round((100 - errorRate) * 10) / 10 : 0;
  const uptimePct = requests > 0 ? Math.round((100 - pct(agg.vendorErrors, requests)) * 10) / 10 : 100;
  const enoughSample = requests >= THRESHOLDS.minSampleForRates;

  /* --- freshness: the newest of the database marker and the live snapshot,
         because a buffered flush can be a few seconds behind --- */
  const newest = (a: Date | null | undefined, b: Date | null | undefined): Date | null => {
    if (!a) return b ?? null;
    if (!b) return a;
    return a > b ? a : b;
  };
  const lastRequestAt = newest(marker?.last_request, snapshot?.lastRequestAt);
  const lastSuccessAt = newest(marker?.last_success, snapshot?.lastSuccessAt);
  const lastErrorAt = newest(marker?.last_error, snapshot?.lastErrorAt);
  // Prefer the snapshot's text when it is the newer of the two.
  const snapshotErrorIsNewer =
    snapshot?.lastErrorAt && marker?.last_error ? snapshot.lastErrorAt > marker.last_error : !!snapshot?.lastErrorAt;
  const lastErrorMessage = snapshotErrorIsNewer
    ? (snapshot?.lastErrorMessage ?? "")
    : (lastError?.errorMessage ?? snapshot?.lastErrorMessage ?? "");
  const lastErrorStatus = snapshotErrorIsNewer
    ? (snapshot?.lastErrorStatus ?? 0)
    : (lastError?.status ?? snapshot?.lastErrorStatus ?? 0);

  /* --- quota (calendar month) --- */
  const monthlyQuota = setting?.monthlyQuota ?? 0;
  // Measure against whatever the vendor actually meters: units where we record
  // them, request count where we don't.
  const monthUnits = month?.units ?? 0;
  const monthRequests = month?.total ?? 0;
  const quotaUsed = def.unit === "request" || monthUnits <= 0 ? monthRequests : Math.round(monthUnits);
  const quotaPct = monthlyQuota > 0 ? Math.min(999, Math.round((quotaUsed / monthlyQuota) * 1000) / 10) : null;

  /* --- rate limit headroom --- */
  const rateLimit = snapshot?.rateLimit ?? rate?.rateLimit ?? null;
  const rateRemaining = snapshot?.rateRemaining ?? rate?.rateRemaining ?? null;
  const rateResetAt = snapshot?.rateResetAt ?? rate?.rateResetAt ?? null;
  const rateHeadroomPct = rateLimit && rateLimit > 0 && rateRemaining != null ? (rateRemaining / rateLimit) * 100 : null;

  /* --- cost --- */
  const unitCostUsd =
    setting?.unitCostMicroUsd != null
      ? setting.unitCostMicroUsd / 1_000_000
      : (def.defaultUnitCostUsd ?? null);
  const costUsd = Math.round((agg.costMicro / 1_000_000) * 10000) / 10000;
  const costMonthUsd = Math.round(((month?.cost_micro ?? 0) / 1_000_000) * 10000) / 10000;

  /* --- auth --- */
  const now = Date.now();
  let authStatus: AuthStatus = "ok";
  if (!connected && def.wired) authStatus = "missing";
  else if (keyExpiresAt && keyExpiresAt.getTime() <= now) authStatus = "expired";
  else if (keyExpiresAt && keyExpiresAt.getTime() - now <= THRESHOLDS.keyExpiryWarnDays * 86_400_000)
    authStatus = "expiring";
  else if (agg.authErrors > 0) authStatus = "failing";

  /* --- health + why --- */
  const reasons: string[] = [];
  let score = 0;
  let health: HealthState;

  if (!def.wired) {
    health = "not_configured";
  } else if (!connected) {
    health = "disconnected";
    reasons.push("Credentials not configured");
    score += 100;
  } else if (requests === 0) {
    health = "idle";
  } else {
    health = "healthy";
  }

  // Signals that can escalate a connected provider. Each contributes to the
  // attention score so the Overview can rank "who needs me first".
  if (health !== "disconnected" && health !== "not_configured") {
    if (authStatus === "expired") {
      reasons.push("API key expired");
      score += 90;
      health = "failed";
    } else if (authStatus === "failing") {
      reasons.push(`${agg.authErrors} authentication ${agg.authErrors === 1 ? "failure" : "failures"}`);
      score += 70;
      health = "degraded";
    } else if (authStatus === "expiring") {
      reasons.push("API key expiring soon");
      score += 25;
      if (health === "healthy") health = "degraded";
    }

    if (enoughSample && errorRate >= THRESHOLDS.errorRateFail) {
      reasons.push(`${errorRate}% error rate`);
      score += 80;
      health = "failed";
    } else if (errorRate >= THRESHOLDS.errorRateWarn && enoughSample) {
      reasons.push(`${errorRate}% error rate`);
      score += 40;
      if (health === "healthy" || health === "idle") health = "degraded";
    }

    if (agg.p95 >= THRESHOLDS.latencyFailMs) {
      reasons.push(`p95 latency ${Math.round(agg.p95)}ms`);
      score += 45;
      if (health !== "failed") health = "degraded";
    } else if (agg.p95 >= THRESHOLDS.latencyWarnMs) {
      reasons.push(`p95 latency ${Math.round(agg.p95)}ms`);
      score += 20;
      if (health === "healthy" || health === "idle") health = "degraded";
    }

    if (quotaPct != null && quotaPct >= THRESHOLDS.quotaFailPct) {
      reasons.push(`${quotaPct}% of monthly quota used`);
      score += 60;
      if (health !== "failed") health = "degraded";
    } else if (quotaPct != null && quotaPct >= THRESHOLDS.quotaWarnPct) {
      reasons.push(`${quotaPct}% of monthly quota used`);
      score += 30;
      if (health === "healthy" || health === "idle") health = "degraded";
    }

    if (rateHeadroomPct != null && rateHeadroomPct <= THRESHOLDS.rateHeadroomWarnPct) {
      reasons.push(`${Math.round(rateHeadroomPct)}% rate-limit headroom left`);
      score += 35;
      if (health === "healthy" || health === "idle") health = "degraded";
    }

    if (incident && incident.indicator === "critical") {
      reasons.push(`Provider incident: ${incident.description}`);
      score += 75;
      health = "failed";
    } else if (incident && (incident.indicator === "major" || incident.indicator === "minor")) {
      reasons.push(`Provider incident: ${incident.description}`);
      score += incident.indicator === "major" ? 50 : 20;
      if (health === "healthy" || health === "idle") health = "degraded";
    }
  }

  // A muted provider still reports its true health — muting silences alerts, it
  // does not repaint the dashboard green. It only drops out of the ranking.
  if (muted) score = 0;

  const windowHours = Math.max(input.windowHours, 1 / 60);

  return {
    id: def.id,
    name: def.name,
    category: def.category,
    categoryLabel: CATEGORY_LABEL[def.category],
    blurb: def.blurb,

    wired: def.wired,
    connected,
    inUse: isProviderInUse({ wired: def.wired, connected, requests, lastRequestAt }),
    authMethod: def.authMethod,
    authLabel: AUTH_LABEL[def.authMethod],
    authStatus,
    environment,
    apiVersion: def.apiVersion ?? null,
    keyExpiresAt: isoOrNull(keyExpiresAt),
    muted,

    health,
    attentionScore: score,
    attentionReasons: reasons,

    requests,
    errors,
    successRate,
    errorRate,
    uptimePct,
    requestsPerHour: Math.round((requests / windowHours) * 10) / 10,
    requestsToday: input.todayCount,
    requestsThisMonth: monthRequests,

    latencyP50: Math.round(agg.p50),
    latencyP95: Math.round(agg.p95),
    latencyP99: Math.round(agg.p99),
    latencyAvg: Math.round(agg.avgMs),

    lastRequestAt: isoOrNull(lastRequestAt),
    lastSuccessAt: isoOrNull(lastSuccessAt),
    lastErrorAt: isoOrNull(lastErrorAt),
    lastErrorMessage,
    lastErrorStatus,

    monthlyQuota,
    quotaUsed,
    quotaPct,
    rateLimitPerMin: setting?.rateLimitPerMin ?? 0,
    rateLimit,
    rateRemaining,
    rateResetAt: isoOrNull(rateResetAt),

    costUsd,
    costMonthUsd,
    costConfidence: def.costConfidence,
    unit: def.unit,
    unitLabel: UNIT_LABEL[def.unit],
    unitCostUsd,
    units: Math.round(agg.units * 100) / 100,

    incidentIndicator: incident?.indicator ?? "unknown",
    incidentDescription: incident?.description ?? "",
    incidentCount: incident?.count ?? 0,
    statusPageUrl: def.statusPageUrl ?? null,
    dashboardUrl: def.dashboardUrl ?? null,
    docsUrl: def.docsUrl,

    webhookDirection: def.webhooks ?? null,
    webhookTotal: webhook?.total ?? 0,
    webhookFailed: webhook?.failed ?? 0,
    webhookSuccessRate: webhook && webhook.total > 0 ? pct(webhook.total - webhook.failed, webhook.total) : null,

    trend: agg.trend,
  };
}

/* ---------------------------- Snapshot API ------------------------- */

export interface CategoryRollup {
  category: ApiCategory;
  label: string;
  providers: number;
  connected: number;
  healthy: number;
  degraded: number;
  failed: number;
  requests: number;
  errors: number;
  costUsd: number;
}

export interface ApiCenterSnapshot {
  generatedAt: string;
  range: { key: RangeKey; label: string; from: string; to: string; bucketSec: number };
  totals: {
    providers: number;
    wired: number;
    connected: number;
    healthy: number;
    degraded: number;
    failed: number;
    disconnected: number;
    idle: number;
    requests: number;
    errors: number;
    errorRate: number;
    successRate: number;
    uptimePct: number;
    latencyP50: number;
    latencyP95: number;
    costUsd: number;
    costMonthUsd: number;
    activeIncidents: number;
    openAlerts: number;
  };
  providers: ProviderRow[];
  categories: CategoryRollup[];
  /** Fleet-wide traffic over the window — the Overview's headline chart. */
  series: SeriesPoint[];
}

/** The whole dashboard in one call — every screen is a view of the same rows, so separate fetches would show slightly different moments. */
export async function apiCenterSnapshot(
  rangeKey?: string,
  opts: { environment?: string } = {},
): Promise<ApiCenterSnapshot> {
  const range = resolveRange(rangeKey);
  const to = new Date();
  const from = new Date(to.getTime() - range.ms);
  const monthStart = new Date(Date.UTC(to.getUTCFullYear(), to.getUTCMonth(), 1));
  const dayStart = new Date(to.getTime() - 24 * 60 * 60 * 1000);

  const [buckets, markers, lastErrors, rates, months, todays, settings, webhookRows, openAlerts] = await Promise.all([
    bucketRows(from, to, range.bucketSec, opts.environment).catch(() => [] as BucketRow[]),
    markerRows().catch(() => [] as MarkerRow[]),
    lastErrorRows().catch(() => [] as LastErrorRow[]),
    rateRows().catch(() => [] as RateRow[]),
    monthRows(monthStart, opts.environment).catch(() => [] as MonthRow[]),
    todayRows(dayStart, opts.environment).catch(() => [] as TodayRow[]),
    prisma.apiProviderSetting.findMany().catch(() => []),
    // The delivery log lives in each brand's database; this is the platform's
    // view, so every brand's counts are merged per provider and outcome.
    allTenants()
      .then((tenants) =>
        Promise.all(
          tenants.map(({ db }) =>
            db.webhookDelivery.groupBy({
              by: ["provider", "success"],
              where: { createdAt: { gte: from } },
              _count: { _all: true },
            }),
          ),
        ),
      )
      .then((groups) => {
        const merged = new Map<string, { provider: string; success: boolean; _count: { _all: number } }>();
        for (const g of groups.flat()) {
          const key = `${g.provider}|${g.success}`;
          const row = merged.get(key) ?? { provider: g.provider, success: g.success, _count: { _all: 0 } };
          row._count._all += g._count._all;
          merged.set(key, row);
        }
        return [...merged.values()];
      })
      .catch(() => [] as Array<{ provider: string; success: boolean; _count: { _all: number } }>),
    prisma.apiAlertEvent.count({ where: { resolvedAt: null } }).catch(() => 0),
  ]);

  /* --- vendor status, for every provider that publishes one --- */
  const statusIds = PROVIDER_DEFS.filter((p) => p.statusApiUrl).map((p) => p.id);
  const statuses = await getProviderStatuses(statusIds).catch(() => new Map());

  /* --- index the raw rows --- */
  const settingByProvider = new Map(settings.map((s) => [s.provider, s]));
  const markerByProvider = new Map(markers.map((m) => [m.provider, m]));
  const lastErrorByProvider = new Map(lastErrors.map((e) => [e.provider, e]));
  const rateByProvider = new Map(rates.map((r) => [r.provider, r]));
  const monthByProvider = new Map(months.map((m) => [m.provider, m]));
  const todayByProvider = new Map(todays.map((t) => [t.provider, t.total]));

  // WebhookDelivery uses its own vendor keys; map them onto trace provider ids.
  const WEBHOOK_PROVIDER_MAP: Record<string, string> = { perfex: "crm", custom: "webhook" };
  const webhookByProvider = new Map<string, { total: number; failed: number }>();
  for (const row of webhookRows) {
    const id = WEBHOOK_PROVIDER_MAP[row.provider] ?? row.provider;
    const entry = webhookByProvider.get(id) ?? { total: 0, failed: 0 };
    entry.total += row._count._all;
    if (!row.success) entry.failed += row._count._all;
    webhookByProvider.set(id, entry);
  }

  /* --- build the bucket timeline, so every provider shares one x-axis --- */
  const bucketStarts: number[] = [];
  const firstBucket = Math.floor(from.getTime() / 1000 / range.bucketSec) * range.bucketSec;
  const lastBucket = Math.floor(to.getTime() / 1000 / range.bucketSec) * range.bucketSec;
  for (let b = firstBucket; b <= lastBucket; b += range.bucketSec) bucketStarts.push(b);
  const bucketIndex = new Map(bucketStarts.map((b, i) => [b, i]));

  /* --- fold buckets into per-provider totals + per-provider trend arrays --- */
  interface Agg extends ProviderAgg {
    /** Weighted percentile accumulation — see the note below. */
    p50Weighted: number;
    p95Weighted: number;
    p99Weighted: number;
  }
  const emptyAgg = (): Agg => ({
    requests: 0,
    errors: 0,
    vendorErrors: 0,
    authErrors: 0,
    costMicro: 0,
    units: 0,
    p50: 0,
    p95: 0,
    p99: 0,
    avgMs: 0,
    trend: {
      requests: new Array(bucketStarts.length).fill(0),
      errors: new Array(bucketStarts.length).fill(0),
      costUsd: new Array(bucketStarts.length).fill(0),
      p95: new Array(bucketStarts.length).fill(0),
    },
    p50Weighted: 0,
    p95Weighted: 0,
    p99Weighted: 0,
  });

  const aggByProvider = new Map<string, Agg>();
  const fleetSeries: SeriesPoint[] = bucketStarts.map((b) => ({
    t: new Date(b * 1000).toISOString(),
    requests: 0,
    errors: 0,
    vendorErrors: 0,
    p50: 0,
    p95: 0,
    p99: 0,
    avgMs: 0,
    costUsd: 0,
    units: 0,
  }));
  // Percentiles can't be summed; traffic-weight each bucket's percentile instead. Not a true
  // global percentile, but a quiet bucket of three slow calls can't dominate the headline.
  const fleetWeighted = bucketStarts.map(() => ({ p50: 0, p95: 0, p99: 0, ms: 0 }));

  for (const row of buckets) {
    const agg = aggByProvider.get(row.provider) ?? emptyAgg();
    agg.requests += row.total;
    agg.errors += row.errors;
    agg.vendorErrors += row.vendor_errors;
    agg.authErrors += row.auth_errors;
    agg.costMicro += row.cost_micro;
    agg.units += row.units;
    agg.p50Weighted += row.p50 * row.total;
    agg.p95Weighted += row.p95 * row.total;
    agg.p99Weighted += row.p99 * row.total;
    agg.avgMs += row.avg_ms * row.total;

    const idx = bucketIndex.get(row.bucket);
    if (idx !== undefined) {
      agg.trend.requests[idx] += row.total;
      agg.trend.errors[idx] += row.errors;
      agg.trend.costUsd[idx] += row.cost_micro / 1_000_000;
      // One provider has at most one row per bucket, so this is an assignment
      // rather than an accumulation — p95 values must never be summed.
      agg.trend.p95[idx] = Math.round(row.p95);
      const point = fleetSeries[idx];
      point.requests += row.total;
      point.errors += row.errors;
      point.vendorErrors += row.vendor_errors;
      point.costUsd += row.cost_micro / 1_000_000;
      point.units += row.units;
      const w = fleetWeighted[idx];
      w.p50 += row.p50 * row.total;
      w.p95 += row.p95 * row.total;
      w.p99 += row.p99 * row.total;
      w.ms += row.avg_ms * row.total;
    }
    aggByProvider.set(row.provider, agg);
  }

  for (let i = 0; i < fleetSeries.length; i++) {
    const point = fleetSeries[i];
    const w = fleetWeighted[i];
    const n = point.requests || 1;
    point.p50 = Math.round(w.p50 / n);
    point.p95 = Math.round(w.p95 / n);
    point.p99 = Math.round(w.p99 / n);
    point.avgMs = Math.round(w.ms / n);
    point.costUsd = Math.round(point.costUsd * 10000) / 10000;
    point.units = Math.round(point.units * 100) / 100;
  }

  for (const agg of aggByProvider.values()) {
    const n = agg.requests || 1;
    agg.p50 = agg.p50Weighted / n;
    agg.p95 = agg.p95Weighted / n;
    agg.p99 = agg.p99Weighted / n;
    agg.avgMs = agg.avgMs / n;
  }

  /* --- rows --- */
  const connected = connectionMap();
  const windowHours = range.ms / 3_600_000;

  // Registry providers plus any id seen only in the traffic log — nothing that made a real call may be invisible.
  const ids = new Set<string>(PROVIDER_DEFS.map((p) => p.id));
  for (const id of aggByProvider.keys()) ids.add(id);

  const providers: ProviderRow[] = [...ids].map((id) => {
    const def = providerDefOrFallback(id);
    const status = statuses.get(id);
    return deriveRow({
      def,
      connected: connected.get(id) ?? true,
      setting: settingByProvider.get(id) ?? null,
      agg: aggByProvider.get(id) ?? emptyAgg(),
      marker: markerByProvider.get(id),
      lastError: lastErrorByProvider.get(id),
      rate: rateByProvider.get(id),
      month: monthByProvider.get(id),
      todayCount: todayByProvider.get(id) ?? 0,
      incident: status
        ? { indicator: status.indicator, description: status.description, count: status.incidents.length }
        : undefined,
      webhook: webhookByProvider.get(id),
      windowHours,
    });
  });

  // Attention first, then traffic. An operator opening this screen is asking
  // "what needs me?", not "what is alphabetically first".
  providers.sort((a, b) => b.attentionScore - a.attentionScore || b.requests - a.requests || a.name.localeCompare(b.name));

  /* --- rollups --- */
  const categories: CategoryRollup[] = CATEGORY_ORDER.map((category) => {
    const inCat = providers.filter((p) => p.category === category);
    return {
      category,
      label: CATEGORY_LABEL[category],
      providers: inCat.length,
      connected: inCat.filter((p) => p.connected && p.wired).length,
      healthy: inCat.filter((p) => p.health === "healthy").length,
      degraded: inCat.filter((p) => p.health === "degraded").length,
      failed: inCat.filter((p) => p.health === "failed" || p.health === "disconnected").length,
      requests: inCat.reduce((s, p) => s + p.requests, 0),
      errors: inCat.reduce((s, p) => s + p.errors, 0),
      costUsd: Math.round(inCat.reduce((s, p) => s + p.costUsd, 0) * 10000) / 10000,
    };
  }).filter((c) => c.providers > 0);

  const totalRequests = providers.reduce((s, p) => s + p.requests, 0);
  const totalErrors = providers.reduce((s, p) => s + p.errors, 0);
  const totalVendorErrors = buckets.reduce((s, b) => s + b.vendor_errors, 0);
  const costMonthUsd =
    Math.round((months.reduce((s, m) => s + m.cost_micro, 0) / 1_000_000) * 100) / 100;

  const weightedP50 = totalRequests > 0 ? providers.reduce((s, p) => s + p.latencyP50 * p.requests, 0) / totalRequests : 0;
  const weightedP95 = totalRequests > 0 ? providers.reduce((s, p) => s + p.latencyP95 * p.requests, 0) / totalRequests : 0;

  return {
    generatedAt: to.toISOString(),
    range: {
      key: range.key,
      label: range.label,
      from: from.toISOString(),
      to: to.toISOString(),
      bucketSec: range.bucketSec,
    },
    totals: {
      providers: providers.length,
      wired: providers.filter((p) => p.wired).length,
      connected: providers.filter((p) => p.wired && p.connected).length,
      healthy: providers.filter((p) => p.health === "healthy").length,
      degraded: providers.filter((p) => p.health === "degraded").length,
      failed: providers.filter((p) => p.health === "failed").length,
      disconnected: providers.filter((p) => p.health === "disconnected").length,
      idle: providers.filter((p) => p.health === "idle").length,
      requests: totalRequests,
      errors: totalErrors,
      errorRate: pct(totalErrors, totalRequests),
      successRate: totalRequests > 0 ? Math.round((100 - pct(totalErrors, totalRequests)) * 10) / 10 : 0,
      uptimePct: totalRequests > 0 ? Math.round((100 - pct(totalVendorErrors, totalRequests)) * 10) / 10 : 100,
      latencyP50: Math.round(weightedP50),
      latencyP95: Math.round(weightedP95),
      costUsd: Math.round(providers.reduce((s, p) => s + p.costUsd, 0) * 100) / 100,
      costMonthUsd,
      activeIncidents: providers.filter(
        (p) => p.incidentIndicator !== "none" && p.incidentIndicator !== "unknown",
      ).length,
      openAlerts,
    },
    providers,
    categories,
    series: fleetSeries,
  };
}

/* --------------------------- Provider detail ----------------------- */

export interface EndpointStat {
  endpoint: string;
  method: string;
  requests: number;
  errors: number;
  errorRate: number;
  p95: number;
  avgMs: number;
}

export interface ApiLogEntry {
  id: string;
  provider: string;
  providerName: string;
  endpoint: string;
  method: string;
  status: number;
  ok: boolean;
  durationMs: number;
  environment: string;
  errorCode: string;
  errorMessage: string;
  units: number;
  costUsd: number;
  createdAt: string;
}

export interface ProviderDetail {
  provider: ProviderRow;
  series: SeriesPoint[];
  endpoints: EndpointStat[];
  recentErrors: ApiLogEntry[];
  recentRequests: ApiLogEntry[];
  incidents: ProviderIncident[];
  statusDescription: string;
  statusIndicator: StatusIndicator;
}

function toLogEntry(row: {
  id: string;
  provider: string;
  endpoint: string;
  method: string;
  status: number;
  ok: boolean;
  durationMs: number;
  environment: string;
  errorCode: string;
  errorMessage: string;
  units: number;
  costMicroUsd: number;
  createdAt: Date;
}): ApiLogEntry {
  return {
    id: row.id,
    provider: row.provider,
    providerName: providerDefOrFallback(row.provider).name,
    endpoint: row.endpoint,
    method: row.method,
    status: row.status,
    ok: row.ok,
    durationMs: row.durationMs,
    environment: row.environment,
    errorCode: row.errorCode,
    errorMessage: row.errorMessage,
    units: row.units,
    costUsd: row.costMicroUsd / 1_000_000,
    createdAt: row.createdAt.toISOString(),
  };
}

/** Everything the provider side-panel shows. */
export async function providerDetail(providerId: string, rangeKey?: string): Promise<ProviderDetail> {
  const range = resolveRange(rangeKey);
  const to = new Date();
  const from = new Date(to.getTime() - range.ms);

  const [snapshot, buckets, endpoints, recentErrors, recentRequests, statuses] = await Promise.all([
    apiCenterSnapshot(rangeKey),
    bucketRows(from, to, range.bucketSec).catch(() => [] as BucketRow[]),
    prisma
      .$queryRaw<Array<{ endpoint: string; method: string; total: number; errors: number; p95: number; avg_ms: number }>>`
        SELECT
          "endpoint",
          "method",
          count(*)::int AS total,
          count(*) FILTER (WHERE NOT "ok")::int AS errors,
          coalesce(percentile_cont(0.95) WITHIN GROUP (ORDER BY "durationMs"), 0)::float8 AS p95,
          coalesce(avg("durationMs"), 0)::float8 AS avg_ms
        FROM "api_request_logs"
        WHERE "provider" = ${providerId} AND "createdAt" >= ${from} AND "createdAt" < ${to}
        GROUP BY "endpoint", "method"
        ORDER BY total DESC
        LIMIT 15
      `
      .catch(() => []),
    prisma.apiRequestLog
      .findMany({ where: { provider: providerId, ok: false }, orderBy: { createdAt: "desc" }, take: 20 })
      .catch(() => []),
    prisma.apiRequestLog
      .findMany({ where: { provider: providerId }, orderBy: { createdAt: "desc" }, take: 25 })
      .catch(() => []),
    getProviderStatuses([providerId]).catch(() => new Map()),
  ]);

  const provider =
    snapshot.providers.find((p) => p.id === providerId) ??
    // A provider id with no registry entry and no traffic still has to render
    // something rather than 404 the whole panel.
    ({ ...providerDefOrFallback(providerId), health: "not_configured" } as unknown as ProviderRow);

  /* Rebuild this provider's own series on the shared bucket grid. */
  const bucketStarts: number[] = [];
  const firstBucket = Math.floor(from.getTime() / 1000 / range.bucketSec) * range.bucketSec;
  const lastBucket = Math.floor(to.getTime() / 1000 / range.bucketSec) * range.bucketSec;
  for (let b = firstBucket; b <= lastBucket; b += range.bucketSec) bucketStarts.push(b);
  const byBucket = new Map(buckets.filter((b) => b.provider === providerId).map((b) => [b.bucket, b]));

  const series: SeriesPoint[] = bucketStarts.map((b) => {
    const row = byBucket.get(b);
    return {
      t: new Date(b * 1000).toISOString(),
      requests: row?.total ?? 0,
      errors: row?.errors ?? 0,
      vendorErrors: row?.vendor_errors ?? 0,
      p50: Math.round(row?.p50 ?? 0),
      p95: Math.round(row?.p95 ?? 0),
      p99: Math.round(row?.p99 ?? 0),
      avgMs: Math.round(row?.avg_ms ?? 0),
      costUsd: Math.round(((row?.cost_micro ?? 0) / 1_000_000) * 10000) / 10000,
      units: Math.round((row?.units ?? 0) * 100) / 100,
    };
  });

  const status = statuses.get(providerId);

  return {
    provider,
    series,
    endpoints: endpoints.map((e) => ({
      endpoint: e.endpoint || "(unlabelled)",
      method: e.method,
      requests: e.total,
      errors: e.errors,
      errorRate: pct(e.errors, e.total),
      p95: Math.round(e.p95),
      avgMs: Math.round(e.avg_ms),
    })),
    recentErrors: recentErrors.map(toLogEntry),
    recentRequests: recentRequests.map(toLogEntry),
    incidents: (status?.incidents ?? []) as ProviderDetail["incidents"],
    statusDescription: status?.description ?? "",
    statusIndicator: status?.indicator ?? "unknown",
  };
}

/* ------------------------------- Logs ------------------------------ */

export interface LogQuery {
  provider?: string;
  status?: "all" | "success" | "error";
  environment?: string;
  search?: string;
  from?: Date;
  to?: Date;
  page?: number;
  pageSize?: number;
}

export interface LogPage {
  rows: ApiLogEntry[];
  total: number;
  page: number;
  pageSize: number;
}

/** The Logs screen: raw request rows, filtered and paged. */
export async function apiLogs(query: LogQuery): Promise<LogPage> {
  const page = Math.max(1, query.page ?? 1);
  const pageSize = Math.min(200, Math.max(10, query.pageSize ?? 50));

  const where: Record<string, unknown> = {};
  if (query.provider && query.provider !== "all") where.provider = query.provider;
  if (query.status === "success") where.ok = true;
  if (query.status === "error") where.ok = false;
  if (query.environment && query.environment !== "all") where.environment = query.environment;
  if (query.from || query.to) {
    where.createdAt = {
      ...(query.from ? { gte: query.from } : {}),
      ...(query.to ? { lte: query.to } : {}),
    };
  }
  if (query.search) {
    where.OR = [
      { endpoint: { contains: query.search, mode: "insensitive" } },
      { errorMessage: { contains: query.search, mode: "insensitive" } },
      { provider: { contains: query.search, mode: "insensitive" } },
    ];
  }

  const [rows, total] = await Promise.all([
    prisma.apiRequestLog.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    prisma.apiRequestLog.count({ where }),
  ]);

  return { rows: rows.map(toLogEntry), total, page, pageSize };
}

/* ------------------------------ Errors ----------------------------- */

export interface ErrorGroup {
  provider: string;
  providerName: string;
  endpoint: string;
  status: number;
  errorCode: string;
  message: string;
  count: number;
  firstSeen: string;
  lastSeen: string;
}

/** Failures grouped by (provider, endpoint, status), not message — vendors embed request ids in the text, so message grouping gives one group per failure. */
export async function errorGroups(rangeKey?: string, provider?: string): Promise<ErrorGroup[]> {
  const range = resolveRange(rangeKey);
  const from = new Date(Date.now() - range.ms);

  const rows = await prisma.$queryRaw<
    Array<{
      provider: string;
      endpoint: string;
      status: number;
      errorCode: string;
      message: string;
      count: number;
      first_seen: Date;
      last_seen: Date;
    }>
  >`
    SELECT
      "provider",
      "endpoint",
      "status",
      max("errorCode")  AS "errorCode",
      max("errorMessage") AS message,
      count(*)::int     AS count,
      min("createdAt")  AS first_seen,
      max("createdAt")  AS last_seen
    FROM "api_request_logs"
    WHERE NOT "ok"
      AND "createdAt" >= ${from}
      AND (${provider ?? null}::text IS NULL OR "provider" = ${provider ?? null}::text)
    GROUP BY "provider", "endpoint", "status"
    ORDER BY count DESC
    LIMIT 100
  `.catch(() => []);

  return rows.map((r) => ({
    provider: r.provider,
    providerName: providerDefOrFallback(r.provider).name,
    endpoint: r.endpoint || "(unlabelled)",
    status: r.status,
    errorCode: r.errorCode ?? "",
    message: r.message ?? "",
    count: r.count,
    firstSeen: r.first_seen.toISOString(),
    lastSeen: r.last_seen.toISOString(),
  }));
}
