import type { ApiCenterSnapshot, ApiCenterTotals, ProviderRow, SeriesPoint } from "@/types/apiCenter";

/* ------------------------------------------------------------------ *
 *  Recomputing the headline numbers for a filtered subset of providers.
 *
 *  The server sends fleet totals plus each provider's own per-bucket trend. When
 *  a filter narrows the fleet, these functions rebuild the totals and the time
 *  series from just the surviving providers, so the number at the top of a
 *  screen always describes the rows underneath it.
 *
 *  Pure functions in their own module so the arithmetic can be tested without
 *  mounting React.
 * ------------------------------------------------------------------ */

/** Percentage to one decimal place, 0 when there's nothing to divide by. */
function pct(part: number, whole: number): number {
  if (whole <= 0) return 0;
  return Math.round((part / whole) * 1000) / 10;
}

function round(n: number, dp: number): number {
  const f = 10 ** dp;
  return Math.round(n * f) / f;
}

/**
 * Traffic-weighted mean of a per-provider latency figure.
 *
 * Percentiles cannot be summed or averaged flat: a provider that served three
 * slow calls must not weigh the same as one that served thirty thousand fast
 * ones. Weighting by request count matches how the server builds the same figure.
 */
function weightedLatency(rows: ProviderRow[], pick: (p: ProviderRow) => number, totalRequests: number): number {
  if (totalRequests <= 0) return 0;
  return Math.round(rows.reduce((sum, p) => sum + pick(p) * p.requests, 0) / totalRequests);
}

/** Totals for exactly the providers given. */
export function deriveTotals(rows: ProviderRow[], snapshot: ApiCenterSnapshot): ApiCenterTotals {
  const requests = rows.reduce((s, p) => s + p.requests, 0);
  const errors = rows.reduce((s, p) => s + p.errors, 0);

  // Availability counts vendor-side failures only. We don't have the raw
  // vendor-error count per provider, but we do have each provider's uptime over
  // the same window — so weight those by traffic, which is the same figure by a
  // different route.
  const uptimePct =
    requests > 0
      ? round(rows.reduce((s, p) => s + p.uptimePct * p.requests, 0) / requests, 1)
      : 100;

  const errorRate = pct(errors, requests);

  return {
    providers: rows.length,
    wired: rows.filter((p) => p.wired).length,
    connected: rows.filter((p) => p.wired && p.connected).length,
    healthy: rows.filter((p) => p.health === "healthy").length,
    degraded: rows.filter((p) => p.health === "degraded").length,
    failed: rows.filter((p) => p.health === "failed").length,
    disconnected: rows.filter((p) => p.health === "disconnected").length,
    idle: rows.filter((p) => p.health === "idle").length,
    requests,
    errors,
    errorRate,
    successRate: requests > 0 ? round(100 - errorRate, 1) : 0,
    uptimePct,
    latencyP50: weightedLatency(rows, (p) => p.latencyP50, requests),
    latencyP95: weightedLatency(rows, (p) => p.latencyP95, requests),
    costUsd: round(
      rows.reduce((s, p) => s + p.costUsd, 0),
      2,
    ),
    // A different window from costUsd — summed from each provider's own
    // month-to-date figure, never inferred from the selected range.
    costMonthUsd: round(
      rows.reduce((s, p) => s + p.costMonthUsd, 0),
      2,
    ),
    activeIncidents: rows.filter((p) => p.incidentIndicator !== "none" && p.incidentIndicator !== "unknown").length,
    // Alerts aren't provider-filterable here — the count stays fleet-wide, which
    // is right: an alert on a provider you've filtered out is still open.
    openAlerts: snapshot.totals.openAlerts,
  };
}

/**
 * Fleet time series rebuilt from the given providers' trend arrays.
 *
 * Every provider's arrays are already aligned to the same bucket timeline by the
 * server, so this is an element-wise sum — except p95, which is traffic-weighted
 * per bucket for the same reason as above.
 */
export function deriveSeries(rows: ProviderRow[], snapshot: ApiCenterSnapshot): SeriesPoint[] {
  return snapshot.series.map((point, i) => {
    let requests = 0;
    let errors = 0;
    let costUsd = 0;
    let p95Weighted = 0;

    for (const p of rows) {
      const n = p.trend.requests[i] ?? 0;
      requests += n;
      errors += p.trend.errors[i] ?? 0;
      costUsd += p.trend.costUsd[i] ?? 0;
      p95Weighted += (p.trend.p95[i] ?? 0) * n;
    }

    return {
      t: point.t,
      requests,
      errors,
      // The subset's vendor-side split isn't carried per bucket; the fleet point
      // is the closest honest value and is only used for a secondary line.
      vendorErrors: requests > 0 ? Math.min(errors, point.vendorErrors) : 0,
      p50: requests > 0 ? point.p50 : 0,
      p95: requests > 0 ? Math.round(p95Weighted / requests) : 0,
      p99: requests > 0 ? point.p99 : 0,
      avgMs: requests > 0 ? point.avgMs : 0,
      costUsd: round(costUsd, 4),
      units: 0,
    };
  });
}
