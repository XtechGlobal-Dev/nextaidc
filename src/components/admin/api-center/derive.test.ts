import { describe, expect, it } from "vitest";
import { deriveSeries, deriveTotals } from "./derive";
import type { ApiCenterSnapshot, ProviderRow, SeriesPoint } from "@/types/apiCenter";

/* ------------------------------------------------------------------ *
 *  The filtered-view arithmetic.
 *
 *  These are the numbers a filter changes, so a mistake here shows up as
 *  "the analytics are wrong" rather than as a crash. The two things worth
 *  pinning down are that rates are weighted by traffic (a provider with three
 *  calls must not swing a fleet percentile) and that per-bucket series sum
 *  element-wise across providers.
 * ------------------------------------------------------------------ */

function provider(over: Partial<ProviderRow> & { id: string }): ProviderRow {
  return {
    name: over.id,
    category: "ai",
    categoryLabel: "AI & LLM",
    blurb: "",
    wired: true,
    connected: true,
    inUse: true,
    authMethod: "api_key",
    authLabel: "API key",
    authStatus: "ok",
    environment: "production",
    apiVersion: null,
    keyExpiresAt: null,
    muted: false,
    health: "healthy",
    attentionScore: 0,
    attentionReasons: [],
    requests: 0,
    errors: 0,
    successRate: 0,
    errorRate: 0,
    uptimePct: 100,
    requestsPerHour: 0,
    requestsToday: 0,
    requestsThisMonth: 0,
    latencyP50: 0,
    latencyP95: 0,
    latencyP99: 0,
    latencyAvg: 0,
    lastRequestAt: null,
    lastSuccessAt: null,
    lastErrorAt: null,
    lastErrorMessage: "",
    lastErrorStatus: 0,
    monthlyQuota: 0,
    quotaUsed: 0,
    quotaPct: null,
    rateLimitPerMin: 0,
    rateLimit: null,
    rateRemaining: null,
    rateResetAt: null,
    costUsd: 0,
    costMonthUsd: 0,
    costConfidence: "none",
    unit: "request",
    unitLabel: "per request",
    unitCostUsd: null,
    units: 0,
    incidentIndicator: "none",
    incidentDescription: "",
    incidentCount: 0,
    statusPageUrl: null,
    dashboardUrl: null,
    docsUrl: "",
    webhookDirection: null,
    webhookTotal: 0,
    webhookFailed: 0,
    webhookSuccessRate: null,
    trend: { requests: [0, 0], errors: [0, 0], costUsd: [0, 0], p95: [0, 0] },
    ...over,
  } as ProviderRow;
}

function point(over: Partial<SeriesPoint> & { t: string }): SeriesPoint {
  return {
    requests: 0,
    errors: 0,
    vendorErrors: 0,
    p50: 0,
    p95: 0,
    p99: 0,
    avgMs: 0,
    costUsd: 0,
    units: 0,
    ...over,
  };
}

function snapshot(series: SeriesPoint[], openAlerts = 0): ApiCenterSnapshot {
  return {
    generatedAt: "2026-08-05T00:00:00.000Z",
    range: {
      key: "24h",
      label: "Last 24 hours",
      from: "2026-08-04T00:00:00.000Z",
      to: "2026-08-05T00:00:00.000Z",
      bucketSec: 1800,
    },
    totals: { openAlerts } as ApiCenterSnapshot["totals"],
    providers: [],
    categories: [],
    series,
    droppedRows: 0,
    thresholds: {} as ApiCenterSnapshot["thresholds"],
  };
}

const EMPTY_SNAPSHOT = snapshot([point({ t: "a" }), point({ t: "b" })]);

describe("deriveTotals", () => {
  it("sums request and error counts across the given providers", () => {
    const totals = deriveTotals(
      [
        provider({ id: "a", requests: 80, errors: 4 }),
        provider({ id: "b", requests: 20, errors: 1 }),
      ],
      EMPTY_SNAPSHOT,
    );
    expect(totals.requests).toBe(100);
    expect(totals.errors).toBe(5);
    expect(totals.errorRate).toBe(5);
    expect(totals.successRate).toBe(95);
  });

  it("weights latency by traffic, so a tiny provider can't swing the fleet figure", () => {
    // 9,990 fast calls and 10 very slow ones. A flat mean would report ~2.5s;
    // the traffic-weighted figure is ~105ms, which is what people experienced.
    const totals = deriveTotals(
      [
        provider({ id: "fast", requests: 9_990, latencyP95: 100 }),
        provider({ id: "slow", requests: 10, latencyP95: 5_000 }),
      ],
      EMPTY_SNAPSHOT,
    );
    expect(totals.latencyP95).toBe(105);
  });

  it("weights uptime by traffic too", () => {
    const totals = deriveTotals(
      [
        provider({ id: "a", requests: 900, uptimePct: 100 }),
        provider({ id: "b", requests: 100, uptimePct: 50 }),
      ],
      EMPTY_SNAPSHOT,
    );
    expect(totals.uptimePct).toBe(95);
  });

  it("reports 100% availability and a zero rate when nothing was called", () => {
    const totals = deriveTotals([provider({ id: "idle" })], EMPTY_SNAPSHOT);
    expect(totals.requests).toBe(0);
    expect(totals.uptimePct).toBe(100);
    expect(totals.errorRate).toBe(0);
    expect(totals.latencyP95).toBe(0);
  });

  it("counts health states and connections", () => {
    const totals = deriveTotals(
      [
        provider({ id: "a", health: "healthy" }),
        provider({ id: "b", health: "degraded" }),
        provider({ id: "c", health: "failed" }),
        provider({ id: "d", health: "disconnected", connected: false }),
        provider({ id: "e", health: "idle" }),
        provider({ id: "f", health: "not_configured", wired: false }),
      ],
      EMPTY_SNAPSHOT,
    );
    expect(totals.providers).toBe(6);
    expect(totals.wired).toBe(5);
    expect(totals.connected).toBe(4);
    expect(totals.healthy).toBe(1);
    expect(totals.degraded).toBe(1);
    expect(totals.failed).toBe(1);
    expect(totals.disconnected).toBe(1);
    expect(totals.idle).toBe(1);
  });

  it("keeps window spend and month-to-date spend as separate figures", () => {
    const totals = deriveTotals(
      [
        provider({ id: "a", costUsd: 1.5, costMonthUsd: 40 }),
        provider({ id: "b", costUsd: 0.25, costMonthUsd: 10 }),
      ],
      EMPTY_SNAPSHOT,
    );
    expect(totals.costUsd).toBe(1.75);
    expect(totals.costMonthUsd).toBe(50);
  });

  it("leaves the open-alert count fleet-wide — filtering a provider out doesn't close its alert", () => {
    const totals = deriveTotals([provider({ id: "a" })], snapshot([point({ t: "a" })], 3));
    expect(totals.openAlerts).toBe(3);
  });
});

describe("deriveSeries", () => {
  it("sums each bucket element-wise across providers", () => {
    const series = deriveSeries(
      [
        provider({
          id: "a",
          trend: { requests: [10, 20], errors: [1, 2], costUsd: [0.1, 0.2], p95: [100, 100] },
        }),
        provider({
          id: "b",
          trend: { requests: [5, 0], errors: [0, 0], costUsd: [0.05, 0], p95: [300, 0] },
        }),
      ],
      EMPTY_SNAPSHOT,
    );
    expect(series.map((s) => s.requests)).toEqual([15, 20]);
    expect(series.map((s) => s.errors)).toEqual([1, 2]);
    expect(series.map((s) => s.costUsd)).toEqual([0.15, 0.2]);
  });

  it("weights each bucket's p95 by that bucket's traffic", () => {
    // Bucket 0: 10 calls at 100ms + 5 calls at 400ms → (1000+2000)/15 = 200.
    const series = deriveSeries(
      [
        provider({ id: "a", trend: { requests: [10, 0], errors: [0, 0], costUsd: [0, 0], p95: [100, 0] } }),
        provider({ id: "b", trend: { requests: [5, 0], errors: [0, 0], costUsd: [0, 0], p95: [400, 0] } }),
      ],
      EMPTY_SNAPSHOT,
    );
    expect(series[0].p95).toBe(200);
  });

  it("zeroes latency in buckets with no traffic rather than carrying the fleet value", () => {
    const withFleetLatency = snapshot([point({ t: "a", p50: 50, p95: 900, avgMs: 120 })]);
    const series = deriveSeries(
      [provider({ id: "a", trend: { requests: [0], errors: [0], costUsd: [0], p95: [0] } })],
      withFleetLatency,
    );
    expect(series[0].requests).toBe(0);
    expect(series[0].p95).toBe(0);
    expect(series[0].p50).toBe(0);
  });

  it("never reports more vendor-side failures than total failures for the subset", () => {
    // The fleet bucket saw 40 vendor errors; this subset only had 2 failures at
    // all, so the vendor-side line must not exceed that.
    const fleet = snapshot([point({ t: "a", requests: 500, errors: 60, vendorErrors: 40 })]);
    const series = deriveSeries(
      [provider({ id: "a", trend: { requests: [9], errors: [2], costUsd: [0], p95: [10] } })],
      fleet,
    );
    expect(series[0].errors).toBe(2);
    expect(series[0].vendorErrors).toBeLessThanOrEqual(series[0].errors);
  });

  it("keeps the snapshot's bucket timestamps so every chart shares one x-axis", () => {
    const series = deriveSeries([provider({ id: "a" })], EMPTY_SNAPSHOT);
    expect(series.map((s) => s.t)).toEqual(["a", "b"]);
  });

  it("returns a zeroed series when no provider survives the filter", () => {
    const series = deriveSeries([], EMPTY_SNAPSHOT);
    expect(series).toHaveLength(2);
    expect(series.every((s) => s.requests === 0 && s.errors === 0)).toBe(true);
  });
});
