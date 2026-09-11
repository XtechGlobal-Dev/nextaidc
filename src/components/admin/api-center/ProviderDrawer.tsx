import * as React from "react";
import { toast } from "sonner";
import {
  Activity,
  AlertOctagon,
  BookOpen,
  ExternalLink,
  Gauge,
  Loader2,
  RefreshCw,
  Rss,
  Settings2,
  Webhook,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { api, ApiError } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { TimeSeriesChart } from "@/components/charts/Charts";
import {
  compactNumber,
  formatBucketFull,
  formatMs,
  formatPct,
  formatUsd,
  timeAgo,
} from "@/components/charts/primitives";
import {
  AuthPill,
  CostConfidenceNote,
  EnvBadge,
  HealthPill,
  IncidentPill,
  ProviderAvatar,
  QuotaMeter,
} from "./shared";
import { useApiCenter } from "./ApiCenterContext";
import type { ApiLogEntry, ProviderDetail } from "@/types/apiCenter";

/* ------------------------------------------------------------------ *
 *  The provider deep-dive.
 *
 *  Opening a provider must answer, in this order: is it healthy, what broke,
 *  what is it costing, and how do I get to the vendor. A side panel rather than
 *  a route so the operator never loses the grid they were scanning — close it
 *  and they are exactly where they were.
 * ------------------------------------------------------------------ */

function StatRow({ label, value, tone }: { label: string; value: React.ReactNode; tone?: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-1.5">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className={cn("text-sm font-medium tabular-nums", tone)}>{value}</dd>
    </div>
  );
}

function StatusChip({ status, ok }: { status: number; ok: boolean }) {
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center rounded-md px-1.5 py-px font-mono text-[10px] font-semibold",
        ok ? "bg-success-tint text-success" : "bg-danger-tint text-danger",
      )}
    >
      {status === 0 ? "ERR" : status}
    </span>
  );
}

function LogRow({ entry }: { entry: ApiLogEntry }) {
  return (
    <li className="flex items-start gap-2 py-2">
      <StatusChip status={entry.status} ok={entry.ok} />
      <div className="min-w-0 flex-1">
        <p className="truncate font-mono text-[11px] text-foreground">
          <span className="text-muted-foreground">{entry.method}</span> {entry.endpoint || "—"}
        </p>
        {entry.errorMessage && (
          <p className="mt-0.5 line-clamp-2 text-[11px] text-danger">{entry.errorMessage}</p>
        )}
      </div>
      <div className="shrink-0 text-right">
        <p className="text-[11px] tabular-nums text-muted-foreground">{formatMs(entry.durationMs)}</p>
        <p className="text-[10px] text-muted-foreground">{timeAgo(entry.createdAt)}</p>
      </div>
    </li>
  );
}

export function ProviderDrawer() {
  const { openProvider, setOpenProvider, filters, snapshot } = useApiCenter();
  const [detail, setDetail] = React.useState<ProviderDetail | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [refreshing, setRefreshing] = React.useState(false);

  const providerId = openProvider;
  const range = filters.range;

  React.useEffect(() => {
    if (!providerId) {
      setDetail(null);
      return;
    }
    let active = true;
    setLoading(true);
    (async () => {
      try {
        const res = await api.admin.apiCenter.provider(providerId, range);
        if (active) setDetail(res);
      } catch (e) {
        if (active) toast.error(e instanceof ApiError ? e.message : "Failed to load provider detail");
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => {
      active = false;
    };
  }, [providerId, range]);

  const refreshStatus = async () => {
    if (!providerId) return;
    setRefreshing(true);
    try {
      const status = await api.admin.apiCenter.refreshStatus(providerId);
      setDetail((d) =>
        d ? { ...d, statusIndicator: status.indicator, statusDescription: status.description, incidents: status.incidents } : d,
      );
      toast.success(`${status.description}`);
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "Couldn't reach the status page");
    } finally {
      setRefreshing(false);
    }
  };

  const p = detail?.provider;
  const labels = detail?.series.map((s) => s.t) ?? [];
  // The drawer plots the same buckets the snapshot used, so its x-axis labels
  // match the charts behind it.
  const bucketSec = snapshot?.range.bucketSec ?? 1800;

  return (
    <Sheet open={!!providerId} onOpenChange={(open) => !open && setOpenProvider(null)}>
      <SheetContent className="max-w-2xl">
        {loading && !detail ? (
          <div className="flex h-full items-center justify-center">
            <Loader2 className="size-6 animate-spin text-muted-foreground" />
          </div>
        ) : !p ? (
          <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
            Provider not found.
          </div>
        ) : (
          <>
            <SheetHeader className="pr-12">
              <div className="flex items-start gap-3">
                <ProviderAvatar name={p.name} className="size-11" />
                <div className="min-w-0 flex-1">
                  <SheetTitle className="flex flex-wrap items-center gap-2">
                    {p.name}
                    <EnvBadge environment={p.environment} />
                    {p.apiVersion && (
                      <span className="rounded-md border border-border px-1.5 py-px font-mono text-[10px] text-muted-foreground">
                        {p.apiVersion}
                      </span>
                    )}
                  </SheetTitle>
                  <p className="mt-0.5 text-sm text-muted-foreground">{p.blurb}</p>
                  <div className="mt-2 flex flex-wrap items-center gap-2">
                    <HealthPill health={p.health} size="xs" />
                    <AuthPill status={p.authStatus} />
                    <IncidentPill indicator={p.incidentIndicator} />
                  </div>
                </div>
              </div>

              {p.attentionReasons.length > 0 && (
                <ul className="mt-3 space-y-1 rounded-lg bg-warning-tint p-2.5">
                  {p.attentionReasons.map((r) => (
                    <li key={r} className="flex items-start gap-1.5 text-xs text-warning">
                      <AlertOctagon className="mt-px size-3.5 shrink-0" />
                      {r}
                    </li>
                  ))}
                </ul>
              )}
            </SheetHeader>

            <Tabs defaultValue="overview" className="flex min-h-0 flex-1 flex-col">
              <div className="border-b border-border px-6 pt-3">
                <TabsList>
                  <TabsTrigger value="overview">Overview</TabsTrigger>
                  <TabsTrigger value="errors">
                    Errors{detail.recentErrors.length > 0 ? ` (${detail.recentErrors.length})` : ""}
                  </TabsTrigger>
                  <TabsTrigger value="endpoints">Endpoints</TabsTrigger>
                  <TabsTrigger value="logs">Logs</TabsTrigger>
                  <TabsTrigger value="config">Config</TabsTrigger>
                </TabsList>
              </div>

              <div className="min-h-0 flex-1 overflow-y-auto p-6">
                {/* --------------------------- Overview -------------------------- */}
                <TabsContent value="overview" className="mt-0 space-y-5">
                  <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
                    {[
                      { label: "Requests", value: compactNumber(p.requests) },
                      {
                        label: "Success rate",
                        value: p.requests > 0 ? formatPct(p.successRate) : "—",
                        tone: p.errorRate >= 25 ? "text-danger" : p.errorRate >= 5 ? "text-warning" : "text-success",
                      },
                      { label: "p95 latency", value: p.requests > 0 ? formatMs(p.latencyP95) : "—" },
                      { label: "Uptime", value: p.requests > 0 ? formatPct(p.uptimePct) : "—" },
                    ].map((s) => (
                      <div key={s.label} className="rounded-xl border border-border p-3">
                        <p className="text-[11px] text-muted-foreground">{s.label}</p>
                        <p className={cn("mt-1 text-lg font-semibold tabular-nums", s.tone)}>{s.value}</p>
                      </div>
                    ))}
                  </div>

                  <div>
                    <h3 className="mb-2 flex items-center gap-1.5 text-sm font-semibold">
                      <Activity className="size-4 text-primary" /> Traffic
                    </h3>
                    <TimeSeriesChart
                      labels={labels}
                      bucketSec={bucketSec}
                      height={170}
                      series={[
                        {
                          key: "requests",
                          label: "Requests",
                          values: detail.series.map((s) => s.requests),
                          color: "var(--color-primary)",
                          area: true,
                        },
                        {
                          key: "errors",
                          label: "Errors",
                          values: detail.series.map((s) => s.errors),
                          color: "var(--color-danger)",
                        },
                      ]}
                      emptyMessage="No requests to this provider in the selected window"
                    />
                  </div>

                  <div>
                    <h3 className="mb-2 flex items-center gap-1.5 text-sm font-semibold">
                      <Gauge className="size-4 text-primary" /> Latency
                    </h3>
                    <TimeSeriesChart
                      labels={labels}
                      bucketSec={bucketSec}
                      height={150}
                      format={formatMs}
                      series={[
                        {
                          key: "p50",
                          label: "p50",
                          values: detail.series.map((s) => s.p50),
                          color: "var(--color-chart-1)",
                        },
                        {
                          key: "p95",
                          label: "p95",
                          values: detail.series.map((s) => s.p95),
                          color: "var(--color-chart-2)",
                        },
                        {
                          key: "p99",
                          label: "p99",
                          values: detail.series.map((s) => s.p99),
                          color: "var(--color-chart-5)",
                        },
                      ]}
                      emptyMessage="No latency samples in the selected window"
                    />
                  </div>

                  <div className="grid gap-5 sm:grid-cols-2">
                    <div>
                      <h3 className="mb-1 text-sm font-semibold">Quota (this month)</h3>
                      <QuotaMeter used={p.quotaUsed} quota={p.monthlyQuota} pct={p.quotaPct} />
                      <dl className="mt-2">
                        <StatRow
                          label="Rate limit headroom"
                          value={
                            p.rateLimit && p.rateRemaining != null
                              ? `${compactNumber(p.rateRemaining)} / ${compactNumber(p.rateLimit)}`
                              : "Not advertised"
                          }
                        />
                        <StatRow
                          label="Resets"
                          value={p.rateResetAt ? formatBucketFull(p.rateResetAt) : "—"}
                        />
                      </dl>
                    </div>

                    <div>
                      <h3 className="mb-1 text-sm font-semibold">Cost ({filters.range})</h3>
                      <p className="text-2xl font-semibold tabular-nums">{formatUsd(p.costUsd)}</p>
                      <CostConfidenceNote confidence={p.costConfidence} className="mt-0.5" />
                      <dl className="mt-2">
                        <StatRow label="Unit" value={p.unitLabel} />
                        <StatRow
                          label="Unit price"
                          value={p.unitCostUsd != null ? `$${p.unitCostUsd}` : "Not set"}
                        />
                        <StatRow label="Units used" value={p.units > 0 ? compactNumber(p.units) : "—"} />
                      </dl>
                    </div>
                  </div>

                  <div>
                    <h3 className="mb-1 text-sm font-semibold">Activity</h3>
                    <dl className="divide-y divide-border">
                      <StatRow label="Last request" value={timeAgo(p.lastRequestAt)} />
                      <StatRow label="Last successful request" value={timeAgo(p.lastSuccessAt)} />
                      <StatRow
                        label="Last error"
                        value={timeAgo(p.lastErrorAt)}
                        tone={p.lastErrorAt ? "text-danger" : undefined}
                      />
                      <StatRow label="Requests today" value={compactNumber(p.requestsToday)} />
                      <StatRow label="Requests this month" value={compactNumber(p.requestsThisMonth)} />
                    </dl>
                    {p.lastErrorMessage && (
                      <p className="mt-2 rounded-lg bg-danger-tint p-2.5 font-mono text-[11px] leading-relaxed text-danger">
                        {p.lastErrorMessage}
                      </p>
                    )}
                  </div>

                  {p.webhookDirection && (
                    <div>
                      <h3 className="mb-1 flex items-center gap-1.5 text-sm font-semibold">
                        <Webhook className="size-4 text-primary" /> Webhooks
                      </h3>
                      <dl className="divide-y divide-border">
                        <StatRow label="Direction" value={p.webhookDirection} />
                        <StatRow label="Deliveries" value={compactNumber(p.webhookTotal)} />
                        <StatRow
                          label="Delivery success"
                          value={p.webhookSuccessRate != null ? formatPct(p.webhookSuccessRate) : "—"}
                          tone={
                            p.webhookSuccessRate != null && p.webhookSuccessRate < 90 ? "text-danger" : undefined
                          }
                        />
                      </dl>
                    </div>
                  )}

                  <div>
                    <h3 className="mb-1 flex items-center gap-1.5 text-sm font-semibold">
                      <Rss className="size-4 text-primary" /> Provider status
                    </h3>
                    <div className="flex flex-wrap items-center gap-2">
                      <IncidentPill indicator={detail.statusIndicator} />
                      <span className="text-xs text-muted-foreground">{detail.statusDescription}</span>
                      {p.statusPageUrl && (
                        <Button variant="ghost" size="sm" onClick={refreshStatus} disabled={refreshing}>
                          {refreshing ? (
                            <Loader2 className="size-4 animate-spin" />
                          ) : (
                            <RefreshCw className="size-4" />
                          )}
                          Re-check
                        </Button>
                      )}
                    </div>
                    {detail.incidents.length > 0 && (
                      <ul className="mt-2 space-y-2">
                        {detail.incidents.map((i) => (
                          <li key={i.id} className="rounded-lg border border-warning/40 bg-warning-tint p-2.5">
                            <p className="text-xs font-semibold text-warning">{i.name}</p>
                            <p className="mt-0.5 text-[11px] capitalize text-muted-foreground">
                              {i.status} · impact {i.impact} · started {timeAgo(i.startedAt)}
                            </p>
                            {i.shortlink && (
                              <a
                                href={i.shortlink}
                                target="_blank"
                                rel="noreferrer noopener"
                                className="mt-1 inline-flex items-center gap-1 text-[11px] font-medium text-primary hover:underline"
                              >
                                Vendor update <ExternalLink className="size-3" />
                              </a>
                            )}
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                </TabsContent>

                {/* ---------------------------- Errors --------------------------- */}
                <TabsContent value="errors" className="mt-0">
                  {detail.recentErrors.length === 0 ? (
                    <p className="py-10 text-center text-sm text-muted-foreground">
                      No failures recorded for {p.name}. 🎉
                    </p>
                  ) : (
                    <ul className="divide-y divide-border">
                      {detail.recentErrors.map((e) => (
                        <LogRow key={e.id} entry={e} />
                      ))}
                    </ul>
                  )}
                </TabsContent>

                {/* --------------------------- Endpoints ------------------------- */}
                <TabsContent value="endpoints" className="mt-0">
                  {detail.endpoints.length === 0 ? (
                    <p className="py-10 text-center text-sm text-muted-foreground">
                      No endpoint activity in this window.
                    </p>
                  ) : (
                    <div className="overflow-x-auto">
                      <table className="w-full min-w-[30rem] text-sm">
                        <thead>
                          <tr className="border-b border-border text-left text-[11px] uppercase tracking-wide text-muted-foreground">
                            <th className="pb-2 font-medium">Endpoint</th>
                            <th className="pb-2 text-right font-medium">Calls</th>
                            <th className="pb-2 text-right font-medium">Errors</th>
                            <th className="pb-2 text-right font-medium">p95</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-border">
                          {detail.endpoints.map((e) => (
                            <tr key={`${e.method}-${e.endpoint}`}>
                              <td className="py-2 pr-3">
                                <span className="font-mono text-[11px] text-muted-foreground">{e.method}</span>{" "}
                                <span className="font-mono text-[11px]">{e.endpoint}</span>
                              </td>
                              <td className="py-2 text-right tabular-nums">{compactNumber(e.requests)}</td>
                              <td
                                className={cn(
                                  "py-2 text-right tabular-nums",
                                  e.errors > 0 ? "text-danger" : "text-muted-foreground",
                                )}
                              >
                                {e.errors > 0 ? `${e.errors} (${formatPct(e.errorRate)})` : "0"}
                              </td>
                              <td className="py-2 text-right tabular-nums">{formatMs(e.p95)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </TabsContent>

                {/* ----------------------------- Logs ---------------------------- */}
                <TabsContent value="logs" className="mt-0">
                  {detail.recentRequests.length === 0 ? (
                    <p className="py-10 text-center text-sm text-muted-foreground">No requests recorded yet.</p>
                  ) : (
                    <ul className="divide-y divide-border">
                      {detail.recentRequests.map((e) => (
                        <LogRow key={e.id} entry={e} />
                      ))}
                    </ul>
                  )}
                </TabsContent>

                {/* ---------------------------- Config --------------------------- */}
                <TabsContent value="config" className="mt-0 space-y-4">
                  <dl className="divide-y divide-border">
                    <StatRow label="Provider key" value={<code className="font-mono text-xs">{p.id}</code>} />
                    <StatRow label="Category" value={p.categoryLabel} />
                    <StatRow label="Authentication" value={p.authLabel} />
                    <StatRow label="API version" value={p.apiVersion ?? "Unpinned"} />
                    <StatRow label="Environment" value={p.environment} />
                    <StatRow
                      label="Key expires"
                      value={p.keyExpiresAt ? formatBucketFull(p.keyExpiresAt) : "No expiry set"}
                    />
                    <StatRow label="Billing unit" value={p.unitLabel} />
                    <StatRow label="Monthly quota" value={p.monthlyQuota > 0 ? compactNumber(p.monthlyQuota) : "Not set"} />
                    <StatRow
                      label="Rate limit"
                      value={p.rateLimitPerMin > 0 ? `${compactNumber(p.rateLimitPerMin)}/min` : "Not set"}
                    />
                    <StatRow label="Alerts" value={p.muted ? "Muted" : "Active"} />
                  </dl>

                  <div className="flex flex-wrap gap-2">
                    {p.docsUrl && (
                      <Button asChild variant="outline" size="sm">
                        <a href={p.docsUrl} target="_blank" rel="noreferrer noopener">
                          <BookOpen className="size-4" /> Docs
                        </a>
                      </Button>
                    )}
                    {p.dashboardUrl && (
                      <Button asChild variant="outline" size="sm">
                        <a href={p.dashboardUrl} target="_blank" rel="noreferrer noopener">
                          <ExternalLink className="size-4" /> Vendor dashboard
                        </a>
                      </Button>
                    )}
                    {p.statusPageUrl && (
                      <Button asChild variant="outline" size="sm">
                        <a href={p.statusPageUrl} target="_blank" rel="noreferrer noopener">
                          <Rss className="size-4" /> Status page
                        </a>
                      </Button>
                    )}
                    <Button asChild variant="ghost" size="sm">
                      <a href="/dashboard/admin/api-center/settings">
                        <Settings2 className="size-4" /> Edit in Settings
                      </a>
                    </Button>
                  </div>
                </TabsContent>
              </div>
            </Tabs>
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}
