/* ------------------------------------------------------------------ *
 *  Turning API Center telemetry into alerts.
 *
 *  A dashboard only helps someone who is looking at it. Rules here watch the
 *  same numbers the screens show and raise an event when one crosses a line, so
 *  a provider that starts failing at 2am is waiting on the Alerts screen in the
 *  morning rather than being discovered by a customer.
 *
 *  Two behaviours keep this from becoming noise nobody reads:
 *
 *   - **Cooldown.** A firing rule won't fire again for `cooldownMin`. Without it,
 *     a provider down for an hour produces one event per evaluation.
 *   - **Auto-resolve.** When the metric comes back inside its threshold the open
 *     event is closed automatically. An operator should only ever see alerts
 *     that are still true.
 * ------------------------------------------------------------------ */

import { prisma } from "../prisma.js";
import { providerDefOrFallback } from "./apiProviders.js";
import { apiCenterSnapshot, THRESHOLDS, type ProviderRow } from "./apiCenter.js";
import { publishToAdmins } from "./events.js";

export type AlertMetric = "error_rate" | "latency_p95" | "quota_used" | "uptime" | "no_traffic";

export const METRIC_LABEL: Record<AlertMetric, string> = {
  error_rate: "Error rate",
  latency_p95: "p95 latency",
  quota_used: "Quota used",
  uptime: "Uptime",
  no_traffic: "No traffic",
};

/** Display unit for a metric's threshold — used by the UI and the alert message. */
export const METRIC_UNIT: Record<AlertMetric, string> = {
  error_rate: "%",
  latency_p95: "ms",
  quota_used: "%",
  uptime: "%",
  no_traffic: "min",
};

/**
 * The rules a fresh install starts with, seeded once.
 *
 * All are fleet-wide (`provider: null`) on purpose: a rule per provider would
 * have to be remembered every time a vendor is added, and the one that gets
 * forgotten is always the one that breaks. Thresholds mirror
 * {@link THRESHOLDS} so an alert fires exactly when the dashboard turns amber.
 */
const DEFAULT_RULES = [
  {
    provider: null,
    metric: "error_rate" as const,
    comparator: "gt",
    threshold: THRESHOLDS.errorRateFail,
    windowMin: 60,
    severity: "critical",
    cooldownMin: 60,
  },
  {
    provider: null,
    metric: "error_rate" as const,
    comparator: "gt",
    threshold: THRESHOLDS.errorRateWarn,
    windowMin: 60,
    severity: "warning",
    cooldownMin: 180,
  },
  {
    provider: null,
    metric: "latency_p95" as const,
    comparator: "gt",
    threshold: THRESHOLDS.latencyFailMs,
    windowMin: 60,
    severity: "warning",
    cooldownMin: 120,
  },
  {
    provider: null,
    metric: "quota_used" as const,
    comparator: "gt",
    threshold: THRESHOLDS.quotaWarnPct,
    windowMin: 60,
    severity: "warning",
    cooldownMin: 720,
  },
  {
    provider: null,
    metric: "uptime" as const,
    comparator: "lt",
    threshold: 99,
    windowMin: 60,
    severity: "warning",
    cooldownMin: 120,
  },
];

let seeded = false;

/** Create the default rules the first time the Alerts screen is opened. Idempotent. */
export async function seedDefaultAlertRules(): Promise<void> {
  if (seeded) return;
  seeded = true;
  try {
    const count = await prisma.apiAlertRule.count();
    if (count > 0) return;
    await prisma.apiAlertRule.createMany({ data: DEFAULT_RULES });
  } catch {
    // A failed seed must not break the screen; the next call retries.
    seeded = false;
  }
}

/* ---------------------------- Evaluation --------------------------- */

/** The value a rule watches, read off an already-computed provider row. */
function metricValue(row: ProviderRow, metric: AlertMetric): number | null {
  switch (metric) {
    case "error_rate":
      // Rates on a handful of calls are noise, not signal — same rule the
      // dashboard applies before it paints a provider red.
      return row.requests >= THRESHOLDS.minSampleForRates ? row.errorRate : null;
    case "latency_p95":
      return row.requests > 0 ? row.latencyP95 : null;
    case "quota_used":
      return row.quotaPct;
    case "uptime":
      return row.requests >= THRESHOLDS.minSampleForRates ? row.uptimePct : null;
    case "no_traffic": {
      if (!row.connected || !row.wired) return null;
      if (!row.lastRequestAt) return null;
      return Math.round((Date.now() - new Date(row.lastRequestAt).getTime()) / 60000);
    }
    default:
      return null;
  }
}

function breaches(value: number, comparator: string, threshold: number): boolean {
  return comparator === "lt" ? value < threshold : value > threshold;
}

function describe(row: ProviderRow, metric: AlertMetric, value: number, threshold: number, comparator: string): string {
  const unit = METRIC_UNIT[metric];
  const direction = comparator === "lt" ? "below" : "above";
  return `${row.name}: ${METRIC_LABEL[metric]} is ${value}${unit}, ${direction} the ${threshold}${unit} threshold.`;
}

export interface EvaluationResult {
  fired: number;
  resolved: number;
}

/**
 * Evaluate every enabled rule against the current snapshot.
 *
 * Runs on the scheduler and is also triggered when the Alerts screen loads, so
 * an operator never looks at a stale board. Never throws — a failed evaluation
 * is logged by its absence, not by taking the scheduler down.
 */
export async function evaluateAlertRules(): Promise<EvaluationResult> {
  const result: EvaluationResult = { fired: 0, resolved: 0 };
  try {
    await seedDefaultAlertRules();
    const [rules, snapshot, openEvents] = await Promise.all([
      prisma.apiAlertRule.findMany({ where: { enabled: true } }),
      apiCenterSnapshot("1h"),
      prisma.apiAlertEvent.findMany({ where: { resolvedAt: null } }),
    ]);
    if (rules.length === 0) return result;

    const byId = new Map(snapshot.providers.map((p) => [p.id, p]));
    const now = new Date();
    /** Keyed the same way an open event is, so a breach can be matched to it. */
    const breachKeys = new Set<string>();

    for (const rule of rules) {
      const metric = rule.metric as AlertMetric;
      // A rule with no provider covers everything currently connected; a muted
      // provider is excluded — that is exactly what muting is for.
      const targets = rule.provider
        ? [byId.get(rule.provider)].filter((p): p is ProviderRow => !!p)
        : snapshot.providers.filter((p) => p.wired && p.connected && !p.muted);

      for (const row of targets) {
        if (row.muted) continue;
        const value = metricValue(row, metric);
        if (value === null) continue;
        if (!breaches(value, rule.comparator, rule.threshold)) continue;

        breachKeys.add(`${rule.id}:${row.id}`);

        // Already open for this provider+rule → nothing to raise.
        const alreadyOpen = openEvents.some((e) => e.ruleId === rule.id && e.provider === row.id);
        if (alreadyOpen) continue;

        // Cooldown is per rule: a rule that just fired for one provider stays
        // quiet briefly rather than announcing a fleet-wide vendor outage
        // twenty times in a row.
        if (rule.lastFiredAt && now.getTime() - rule.lastFiredAt.getTime() < rule.cooldownMin * 60_000) continue;

        await prisma.apiAlertEvent.create({
          data: {
            ruleId: rule.id,
            provider: row.id,
            metric: rule.metric,
            severity: rule.severity,
            value,
            threshold: rule.threshold,
            message: describe(row, metric, value, rule.threshold, rule.comparator),
          },
        });
        await prisma.apiAlertRule.update({ where: { id: rule.id }, data: { lastFiredAt: now } });
        rule.lastFiredAt = now;
        result.fired++;
      }
    }

    // Auto-resolve: any open event whose breach is no longer present.
    for (const event of openEvents) {
      if (breachKeys.has(`${event.ruleId}:${event.provider}`)) continue;
      await prisma.apiAlertEvent.update({ where: { id: event.id }, data: { resolvedAt: now } });
      result.resolved++;
    }

    // Nudge open admin tabs so the alert badge updates without a reload.
    if (result.fired > 0 || result.resolved > 0) {
      publishToAdmins({ type: "api-center", fired: result.fired, resolved: result.resolved });
    }
  } catch {
    /* evaluation is best-effort — never break the scheduler over it */
  }
  return result;
}

/* ------------------------------ Reads ------------------------------ */

export interface AlertEventView {
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

export interface AlertRuleView {
  id: string;
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

export async function listAlertRules(): Promise<AlertRuleView[]> {
  await seedDefaultAlertRules();
  const rules = await prisma.apiAlertRule.findMany({ orderBy: [{ enabled: "desc" }, { createdAt: "asc" }] });
  return rules.map((r) => ({
    id: r.id,
    provider: r.provider,
    providerName: r.provider ? providerDefOrFallback(r.provider).name : null,
    metric: r.metric as AlertMetric,
    metricLabel: METRIC_LABEL[r.metric as AlertMetric] ?? r.metric,
    unit: METRIC_UNIT[r.metric as AlertMetric] ?? "",
    comparator: r.comparator,
    threshold: r.threshold,
    windowMin: r.windowMin,
    severity: r.severity,
    enabled: r.enabled,
    cooldownMin: r.cooldownMin,
    lastFiredAt: r.lastFiredAt ? r.lastFiredAt.toISOString() : null,
  }));
}

export async function listAlertEvents(status: "open" | "all" = "open", limit = 100): Promise<AlertEventView[]> {
  const events = await prisma.apiAlertEvent.findMany({
    where: status === "open" ? { resolvedAt: null } : {},
    orderBy: { createdAt: "desc" },
    take: Math.min(500, limit),
  });
  return events.map((e) => ({
    id: e.id,
    ruleId: e.ruleId,
    provider: e.provider,
    providerName: providerDefOrFallback(e.provider).name,
    metric: e.metric as AlertMetric,
    metricLabel: METRIC_LABEL[e.metric as AlertMetric] ?? e.metric,
    unit: METRIC_UNIT[e.metric as AlertMetric] ?? "",
    severity: e.severity,
    value: e.value,
    threshold: e.threshold,
    message: e.message,
    acknowledgedAt: e.acknowledgedAt ? e.acknowledgedAt.toISOString() : null,
    resolvedAt: e.resolvedAt ? e.resolvedAt.toISOString() : null,
    createdAt: e.createdAt.toISOString(),
  }));
}
