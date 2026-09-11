/* ------------------------------------------------------------------ *
 *  Admin → API Center types.
 *
 *  Mirrors the shapes returned by server/src/services/apiCenter.ts and
 *  apiAlerts.ts. Kept in its own module (rather than types/index.ts) because
 *  this is an admin-only surface with a lot of vocabulary, and nothing in the
 *  customer app should have to load it.
 * ------------------------------------------------------------------ */

export type ApiCategory =
  | "ai"
  | "voice"
  | "communication"
  | "calendar"
  | "crm"
  | "payments"
  | "email"
  | "storage"
  | "automation"
  | "monitoring"
  | "data";

/** Time window the whole dashboard is scoped to. */
export type RangeKey = "1h" | "24h" | "7d" | "30d";

/**
 * How a provider is behaving.
 *  - `healthy`        — connected, taking traffic, nothing tripped
 *  - `degraded`       — working, but something is worth knowing about
 *  - `failed`         — actively broken
 *  - `disconnected`   — wired into the platform, but we hold no credentials
 *  - `idle`           — connected and fine, just no traffic in this window
 *  - `not_configured` — a roadmap provider the platform doesn't call yet
 */
export type HealthState = "healthy" | "degraded" | "failed" | "disconnected" | "idle" | "not_configured";

export type AuthStatus = "ok" | "missing" | "expiring" | "expired" | "failing";

/** statuspage.io's indicators, plus `unknown` where a vendor publishes no feed. */
export type StatusIndicator = "none" | "minor" | "major" | "critical" | "maintenance" | "unknown";

export type CostConfidence = "metered" | "estimated" | "none";

export type BillingUnit =
  | "request"
  | "1k_tokens"
  | "1k_chars"
  | "minute"
  | "message"
  | "segment"
  | "gb"
  | "none";

export interface SeriesPoint {
  /** Bucket start, ISO. */
  t: string;
  requests: number;
  errors: number;
  /** Vendor-side failures only — the availability numerator. */
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

  wired: boolean;
  connected: boolean;
  /**
   * Whether this deployment actually uses the provider — the code can call it,
   * and we either hold credentials or have already recorded traffic. Derived at
   * runtime, so local, staging and production each show their own set.
   */
  inUse: boolean;
  authMethod: string;
  authLabel: string;
  authStatus: AuthStatus;
  environment: string;
  apiVersion: string | null;
  keyExpiresAt: string | null;
  muted: boolean;

  health: HealthState;
  /** Higher = more urgent. Drives the Overview's "needs attention" ordering. */
  attentionScore: number;
  attentionReasons: string[];

  requests: number;
  errors: number;
  successRate: number;
  errorRate: number;
  uptimePct: number;
  requestsPerHour: number;
  requestsToday: number;
  requestsThisMonth: number;

  latencyP50: number;
  latencyP95: number;
  latencyP99: number;
  latencyAvg: number;

  lastRequestAt: string | null;
  lastSuccessAt: string | null;
  lastErrorAt: string | null;
  lastErrorMessage: string;
  lastErrorStatus: number;

  monthlyQuota: number;
  quotaUsed: number;
  /** Null when no quota is configured — render "—", never a 0% meter. */
  quotaPct: number | null;
  rateLimitPerMin: number;
  rateLimit: number | null;
  rateRemaining: number | null;
  rateResetAt: string | null;

  costUsd: number;
  /** Calendar month to date — a different window from `costUsd`. */
  costMonthUsd: number;
  costConfidence: CostConfidence;
  unit: BillingUnit;
  unitLabel: string;
  unitCostUsd: number | null;
  units: number;

  incidentIndicator: StatusIndicator;
  incidentDescription: string;
  incidentCount: number;
  statusPageUrl: string | null;
  dashboardUrl: string | null;
  docsUrl: string;

  webhookDirection: "inbound" | "outbound" | "both" | null;
  webhookTotal: number;
  webhookFailed: number;
  webhookSuccessRate: number | null;

  /**
   * This provider's own numbers per time bucket, on the same x-axis as every
   * other provider. Sent per provider so the browser can rebuild the charts and
   * headline figures for any filtered subset — see `useApiCenter().view`.
   */
  trend: {
    requests: number[];
    errors: number[];
    costUsd: number[];
    p95: number[];
  };
}

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

export interface ApiCenterTotals {
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
}

export interface ApiCenterThresholds {
  errorRateWarn: number;
  errorRateFail: number;
  latencyWarnMs: number;
  latencyFailMs: number;
  quotaWarnPct: number;
  quotaFailPct: number;
  rateHeadroomWarnPct: number;
  keyExpiryWarnDays: number;
  minSampleForRates: number;
}

export interface ApiCenterSnapshot {
  generatedAt: string;
  range: { key: RangeKey; label: string; from: string; to: string; bucketSec: number };
  totals: ApiCenterTotals;
  providers: ProviderRow[];
  categories: CategoryRollup[];
  series: SeriesPoint[];
  /** Telemetry rows dropped because the write buffer filled during an outage.
   *  Surfaced so a gap in the data is never read as a quiet period. */
  droppedRows: number;
  thresholds: ApiCenterThresholds;
}

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

export interface ProviderIncident {
  id: string;
  name: string;
  status: string;
  impact: string;
  shortlink: string;
  startedAt: string | null;
  updatedAt: string | null;
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

export interface ApiLogPage {
  rows: ApiLogEntry[];
  total: number;
  page: number;
  pageSize: number;
}

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

export interface ProviderSettingRow {
  provider: string;
  name: string;
  category: ApiCategory;
  unit: BillingUnit;
  costConfidence: CostConfidence;
  monthlyQuota: number;
  unitCostUsd: number | null;
  /** True once an admin has overridden the price shipped in code. */
  unitCostOverridden: boolean;
  rateLimitPerMin: number;
  environment: string;
  keyExpiresAt: string | null;
  muted: boolean;
  notes: string;
}

export interface ApiKeyRow {
  provider: string;
  name: string;
  category: ApiCategory;
  authMethod: string;
  wired: boolean;
  configured: boolean;
  /** Credentials live in the server environment, not the admin UI (e.g. Stripe). */
  managedExternally: boolean;
  fields: { key: string; label: string; isSet: boolean; value: string }[];
  keyExpiresAt: string | null;
  daysToExpiry: number | null;
  environment: string;
  docsUrl: string;
  dashboardUrl: string | null;
}

export type AlertMetric = "error_rate" | "latency_p95" | "quota_used" | "uptime" | "no_traffic";

export interface AlertEvent {
  id: string;
  ruleId: string;
  provider: string;
  providerName: string;
  metric: AlertMetric;
  metricLabel: string;
  unit: string;
  severity: string;
  value: number;
  threshold: number;
  message: string;
  acknowledgedAt: string | null;
  resolvedAt: string | null;
  createdAt: string;
}

export interface AlertRule {
  id: string;
  /** Null = applies to every connected provider. */
  provider: string | null;
  providerName: string | null;
  metric: AlertMetric;
  metricLabel: string;
  unit: string;
  comparator: string;
  threshold: number;
  windowMin: number;
  severity: string;
  enabled: boolean;
  cooldownMin: number;
  lastFiredAt: string | null;
}

export interface AlertsResponse {
  events: AlertEvent[];
  rules: AlertRule[];
}

export interface ProviderStatusPayload {
  provider: string;
  providerName?: string;
  indicator: StatusIndicator;
  description: string;
  incidents: ProviderIncident[];
  statusPageUrl?: string;
  checkedAt: string | null;
}

export interface ApiCenterRegistry {
  categories: { key: ApiCategory; label: string }[];
  providers: {
    id: string;
    name: string;
    category: ApiCategory;
    wired: boolean;
    docsUrl: string;
    dashboardUrl: string | null;
    statusPageUrl: string | null;
  }[];
  metrics: { key: AlertMetric; label: string; unit: string }[];
}
