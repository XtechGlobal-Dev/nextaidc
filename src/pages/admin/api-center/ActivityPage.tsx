import * as React from "react";
import { toast } from "sonner";
import { AlertTriangle, Download, Gauge, Loader2, ScrollText, TrendingUp } from "lucide-react";
import { cn } from "@/lib/utils";
import { env } from "@/lib/env";
import { api, ApiError, getToken, type ApiLogFilters } from "@/lib/api";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { CardSkeleton } from "@/components/ui/skeleton";
import { BarChart, TimeSeriesChart } from "@/components/charts/Charts";
import {
  compactNumber,
  formatBucketFull,
  formatMs,
  formatPct,
  formatUsd,
  timeAgo,
} from "@/components/charts/primitives";
import { useApiCenter } from "@/components/admin/api-center/ApiCenterContext";
import { ApiCenterEmpty, EnvBadge, SectionHeading, Segmented, SummaryBar } from "@/components/admin/api-center/shared";
import type { ApiCenterSnapshot, ApiLogPage, ErrorGroup, ProviderRow } from "@/types/apiCenter";
import type { ApiCenterView } from "@/components/admin/api-center/ApiCenterContext";

/* ------------------------------------------------------------------ *
 *  Activity — traffic, latency, failures and the raw log.
 *
 *  Replaces four screens (Usage, Latency, Errors, Logs) with one chart whose
 *  series change with the view. They were always the same time axis over the
 *  same requests; splitting them across tabs made you re-find your place in
 *  time every time you changed question.
 *
 *  Only the view that needs extra data fetches it: Errors pulls grouped
 *  failures, Logs pages the raw rows. Traffic and Latency come free from the
 *  snapshot the shell already holds.
 *
 *  Each view is a top-level component, NOT a function nested in the page — a
 *  nested one is a new component type on every render, so the live tick would
 *  remount it and silently reset the log's pagination.
 * ------------------------------------------------------------------ */

type View = "traffic" | "latency" | "errors" | "logs";

const VIEWS: { key: View; label: string; icon: typeof TrendingUp }[] = [
  { key: "traffic", label: "Traffic", icon: TrendingUp },
  { key: "latency", label: "Latency", icon: Gauge },
  { key: "errors", label: "Errors", icon: AlertTriangle },
  { key: "logs", label: "Logs", icon: ScrollText },
];

const LOG_PAGE_SIZE = 50;

interface ViewProps {
  snapshot: ApiCenterSnapshot;
  /** Totals + series for the filtered set — never snapshot.totals directly. */
  derived: ApiCenterView;
  providers: ProviderRow[];
  onOpenProvider: (id: string) => void;
}

export default function ApiCenterActivityPage() {
  const { snapshot, view: derived, loading, visibleProviders, setOpenProvider } = useApiCenter();
  const [view, setView] = React.useState<View>("traffic");

  if (loading && !snapshot) return <CardSkeleton rows={8} />;
  if (!snapshot || !derived) return null;

  const props: ViewProps = { snapshot, derived, providers: visibleProviders, onOpenProvider: setOpenProvider };

  return (
    <div className="space-y-4">
      <Segmented value={view} onChange={setView} options={VIEWS} label="Activity view" />
      {view === "traffic" && <TrafficView {...props} />}
      {view === "latency" && <LatencyView {...props} />}
      {view === "errors" && <ErrorsView {...props} />}
      {view === "logs" && <LogsView {...props} />}
    </div>
  );
}

/* ------------------------------ Traffic ---------------------------- */

function TrafficView({ snapshot, derived, providers }: ViewProps) {
  const { totals, series } = derived;
  const { range, thresholds } = snapshot;
  const hasTraffic = totals.requests > 0;

  return (
    <>
      <SummaryBar
        stats={[
          { label: `Requests · ${range.label.replace("Last ", "")}`, value: compactNumber(totals.requests) },
          {
            label: "Success rate",
            value: hasTraffic ? formatPct(totals.successRate) : "—",
            tone: !hasTraffic
              ? "neutral"
              : totals.errorRate >= thresholds.errorRateFail
                ? "danger"
                : totals.errorRate >= thresholds.errorRateWarn
                  ? "warning"
                  : "success",
          },
          { label: "Failed", value: compactNumber(totals.errors), tone: totals.errors > 0 ? "danger" : "neutral" },
        ]}
      />
      <Card className="p-5">
        <SectionHeading title="Request volume" hint={`Successful vs failed calls · ${range.label.toLowerCase()}`} />
        <TimeSeriesChart
          labels={series.map((s) => s.t)}
          bucketSec={range.bucketSec}
          height={220}
          series={[
            {
              key: "requests",
              label: "Requests",
              values: series.map((s) => s.requests),
              color: "var(--color-primary)",
              area: true,
            },
            { key: "errors", label: "Errors", values: series.map((s) => s.errors), color: "var(--color-danger)" },
          ]}
        />
      </Card>
      <Card className="p-5">
        <SectionHeading title="Busiest providers" hint="Share of all calls in this window" />
        <BarChart
          data={providers
            .filter((p) => p.requests > 0)
            .sort((a, b) => b.requests - a.requests)
            .map((p) => ({
              label: p.name,
              value: p.requests,
              hint: `${formatPct((p.requests / Math.max(1, totals.requests)) * 100)} of traffic`,
            }))}
          format={compactNumber}
          emptyMessage="No traffic recorded in this window"
        />
      </Card>
    </>
  );
}

/* ------------------------------ Latency ---------------------------- */

function LatencyView({ snapshot, derived, providers, onOpenProvider }: ViewProps) {
  const { totals, series } = derived;
  const { range, thresholds } = snapshot;
  const active = providers.filter((p) => p.requests > 0).sort((a, b) => b.latencyP95 - a.latencyP95);

  if (active.length === 0) {
    return (
      <ApiCenterEmpty
        icon={Gauge}
        title="No latency samples in this window"
        message="Latency is measured on every traced request. Widen the time range, or wait for the next third-party call."
      />
    );
  }

  return (
    <>
      <SummaryBar
        stats={[
          {
            label: "p95",
            value: formatMs(totals.latencyP95),
            tone:
              totals.latencyP95 >= thresholds.latencyFailMs
                ? "danger"
                : totals.latencyP95 >= thresholds.latencyWarnMs
                  ? "warning"
                  : "success",
          },
          { label: "p50", value: formatMs(totals.latencyP50) },
          {
            label: "Slow providers",
            value: active.filter((p) => p.latencyP95 >= thresholds.latencyWarnMs).length,
            tone: active.some((p) => p.latencyP95 >= thresholds.latencyWarnMs) ? "warning" : "success",
          },
        ]}
      />
      <Card className="p-5">
        <SectionHeading
          title="Response time"
          hint={`Traffic-weighted across every provider · ${range.label.toLowerCase()}`}
        />
        <TimeSeriesChart
          labels={series.map((s) => s.t)}
          bucketSec={range.bucketSec}
          height={220}
          format={formatMs}
          series={[
            // One ordered measure, so a single-hue ramp light→dark rather than
            // three unrelated categorical colours.
            { key: "p50", label: "p50", values: series.map((s) => s.p50), color: "#86b6ef" },
            { key: "p95", label: "p95", values: series.map((s) => s.p95), color: "#2a78d6" },
            { key: "p99", label: "p99", values: series.map((s) => s.p99), color: "#104281" },
          ]}
        />
      </Card>
      <Card className="overflow-hidden">
        <SectionHeading title="Per-provider percentiles" className="p-5 pb-0" hint="Slowest first" />
        <div className="overflow-x-auto">
          <table className="w-full min-w-[36rem] text-sm">
            <thead>
              <tr className="border-b border-border text-left text-[11px] uppercase tracking-wide text-muted-foreground">
                <th className="px-5 py-2 font-medium">Provider</th>
                <th className="px-3 py-2 text-right font-medium">Calls</th>
                <th className="px-3 py-2 text-right font-medium">p50</th>
                <th className="px-3 py-2 text-right font-medium">p95</th>
                <th className="px-5 py-2 text-right font-medium">p99</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {active.map((p) => (
                <tr
                  key={p.id}
                  onClick={() => onOpenProvider(p.id)}
                  className="cursor-pointer transition-colors hover:bg-muted/50"
                >
                  <td className="px-5 py-2.5 font-medium">{p.name}</td>
                  <td className="px-3 py-2.5 text-right tabular-nums text-muted-foreground">
                    {compactNumber(p.requests)}
                  </td>
                  <td className="px-3 py-2.5 text-right tabular-nums">{formatMs(p.latencyP50)}</td>
                  <td
                    className={cn(
                      "px-3 py-2.5 text-right font-semibold tabular-nums",
                      p.latencyP95 >= thresholds.latencyFailMs
                        ? "text-danger"
                        : p.latencyP95 >= thresholds.latencyWarnMs
                          ? "text-warning"
                          : "",
                    )}
                  >
                    {formatMs(p.latencyP95)}
                  </td>
                  <td className="px-5 py-2.5 text-right tabular-nums text-muted-foreground">
                    {formatMs(p.latencyP99)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </>
  );
}

/* ------------------------------- Errors ---------------------------- */

function ErrorsView({ snapshot, derived, providers, onOpenProvider }: ViewProps) {
  const { filters } = useApiCenter();
  const { totals, series } = derived;
  const { range, thresholds } = snapshot;
  const [groups, setGroups] = React.useState<ErrorGroup[] | null>(null);
  const [fetching, setFetching] = React.useState(true);

  React.useEffect(() => {
    let active = true;
    setFetching(true);
    (async () => {
      try {
        const res = await api.admin.apiCenter.errors(filters.range, "all");
        if (active) setGroups(res.groups);
      } catch (e) {
        if (active) toast.error(e instanceof ApiError ? e.message : "Failed to load errors");
      } finally {
        if (active) setFetching(false);
      }
    })();
    return () => {
      active = false;
    };
  }, [filters.range]);

  const allowed = React.useMemo(() => new Set(providers.map((p) => p.id)), [providers]);
  const needle = filters.search.trim().toLowerCase();
  const rows = (groups ?? []).filter(
    (g) =>
      allowed.has(g.provider) &&
      (!needle || g.message.toLowerCase().includes(needle) || g.endpoint.toLowerCase().includes(needle)),
  );

  if (fetching && !groups) return <CardSkeleton rows={6} />;

  return (
    <>
      <SummaryBar
        stats={[
          {
            label: "Failed requests",
            value: compactNumber(totals.errors),
            tone: totals.errors > 0 ? "danger" : "success",
          },
          {
            label: "Error rate",
            value: totals.requests > 0 ? formatPct(totals.errorRate) : "—",
            tone:
              totals.errorRate >= thresholds.errorRateFail
                ? "danger"
                : totals.errorRate >= thresholds.errorRateWarn
                  ? "warning"
                  : "success",
          },
          { label: "Distinct failures", value: rows.length },
        ]}
      />
      <Card className="p-5">
        <SectionHeading title="Failures over time" hint="Provider-side failures separated from our own bad requests" />
        <TimeSeriesChart
          labels={series.map((s) => s.t)}
          bucketSec={range.bucketSec}
          height={180}
          series={[
            {
              key: "errors",
              label: "All errors",
              values: series.map((s) => s.errors),
              color: "var(--color-danger)",
              area: true,
            },
            {
              key: "vendor",
              label: "Provider-side only",
              values: series.map((s) => s.vendorErrors),
              color: "var(--color-warning)",
            },
          ]}
          emptyMessage="No failures recorded in this window 🎉"
        />
      </Card>
      {rows.length === 0 ? (
        <ApiCenterEmpty
          icon={AlertTriangle}
          title="No failures recorded"
          message="Every third-party call in this window succeeded. Nothing to chase."
        />
      ) : (
        <Card className="overflow-hidden">
          <SectionHeading
            title="Grouped failures"
            className="p-5 pb-0"
            hint="Same provider, endpoint and status collapsed into one row"
          />
          <div className="overflow-x-auto">
            <table className="w-full min-w-[42rem] text-sm">
              <thead>
                <tr className="border-b border-border text-left text-[11px] uppercase tracking-wide text-muted-foreground">
                  <th className="px-5 py-2 font-medium">Provider</th>
                  <th className="px-3 py-2 font-medium">Endpoint</th>
                  <th className="px-3 py-2 font-medium">Status</th>
                  <th className="px-3 py-2 text-right font-medium">Count</th>
                  <th className="px-5 py-2 text-right font-medium">Last seen</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {rows.map((g) => (
                  <tr
                    key={`${g.provider}-${g.endpoint}-${g.status}`}
                    onClick={() => onOpenProvider(g.provider)}
                    className="cursor-pointer align-top transition-colors hover:bg-muted/50"
                  >
                    <td className="px-5 py-3 font-medium">{g.providerName}</td>
                    <td className="max-w-[20rem] px-3 py-3">
                      <p className="truncate font-mono text-[11px]" title={g.endpoint}>
                        {g.endpoint}
                      </p>
                      {g.message && (
                        <p className="mt-0.5 line-clamp-2 text-[11px] text-danger" title={g.message}>
                          {g.message}
                        </p>
                      )}
                    </td>
                    <td className="px-3 py-3">
                      <span className="rounded-md bg-danger-tint px-1.5 py-px font-mono text-[10px] font-semibold text-danger">
                        {g.status === 0 ? "ERR" : g.status}
                      </span>
                    </td>
                    <td className="px-3 py-3 text-right font-semibold tabular-nums">{compactNumber(g.count)}</td>
                    <td className="px-5 py-3 text-right text-[11px] text-muted-foreground">{timeAgo(g.lastSeen)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}
    </>
  );
}

/* -------------------------------- Logs ----------------------------- */

function LogsView({ snapshot, onOpenProvider }: ViewProps) {
  const { filters } = useApiCenter();
  const [page, setPage] = React.useState(1);
  const [onlyErrors, setOnlyErrors] = React.useState(false);
  const [data, setData] = React.useState<ApiLogPage | null>(null);
  const [fetching, setFetching] = React.useState(true);
  const [downloading, setDownloading] = React.useState(false);

  const rangeFrom = snapshot.range.from;

  const query: ApiLogFilters = React.useMemo(
    () => ({
      status: onlyErrors ? "error" : "all",
      environment: filters.environment,
      search: filters.search.trim() || undefined,
      from: rangeFrom,
      page,
      pageSize: LOG_PAGE_SIZE,
    }),
    [onlyErrors, filters.environment, filters.search, rangeFrom, page],
  );

  // Any filter change invalidates the page number — page 7 of the old result set
  // is meaningless against the new one.
  React.useEffect(() => {
    setPage(1);
  }, [onlyErrors, filters.environment, filters.search, filters.range]);

  React.useEffect(() => {
    let active = true;
    setFetching(true);
    (async () => {
      try {
        const res = await api.admin.apiCenter.logs(query);
        if (active) setData(res);
      } catch (e) {
        if (active) toast.error(e instanceof ApiError ? e.message : "Failed to load logs");
      } finally {
        if (active) setFetching(false);
      }
    })();
    return () => {
      active = false;
    };
  }, [query]);

  /** Fetch with the auth header, then hand the browser a blob — a plain <a href>
   *  can't carry the bearer token, and a token in the query string would leak
   *  into browser history and any proxy log. */
  const download = async () => {
    setDownloading(true);
    try {
      const res = await fetch(`${env.apiUrl}${api.admin.apiCenter.logsCsvPath(query)}`, {
        headers: { Authorization: `Bearer ${getToken() ?? ""}` },
      });
      if (!res.ok) throw new Error("Export failed");
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `api-logs-${new Date().toISOString().slice(0, 10)}.csv`;
      a.click();
      URL.revokeObjectURL(url);
    } catch {
      toast.error("Couldn't export the log selection");
    } finally {
      setDownloading(false);
    }
  };

  const rows = data?.rows ?? [];
  const totalPages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;

  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <label className="flex cursor-pointer items-center gap-2 text-xs text-muted-foreground">
          <input
            type="checkbox"
            checked={onlyErrors}
            onChange={(e) => setOnlyErrors(e.target.checked)}
            className="size-3.5 rounded border-border"
          />
          Failures only
        </label>
        <div className="flex items-center gap-2">
          {data && (
            <span className="text-xs text-muted-foreground tabular-nums">
              {data.total.toLocaleString()} {data.total === 1 ? "request" : "requests"}
            </span>
          )}
          <Button variant="outline" size="sm" onClick={download} disabled={downloading || rows.length === 0}>
            {downloading ? <Loader2 className="size-4 animate-spin" /> : <Download className="size-4" />}
            Export CSV
          </Button>
        </div>
      </div>

      {fetching && !data ? (
        <CardSkeleton rows={8} />
      ) : rows.length === 0 ? (
        <ApiCenterEmpty
          icon={ScrollText}
          title="No requests match these filters"
          message="Widen the time range, turn off “failures only”, or clear the search above."
        />
      ) : (
        <Card className="overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[46rem] text-sm">
              <thead>
                <tr className="border-b border-border text-left text-[11px] uppercase tracking-wide text-muted-foreground">
                  <th className="px-5 py-2 font-medium">Time</th>
                  <th className="px-3 py-2 font-medium">Provider</th>
                  <th className="px-3 py-2 font-medium">Request</th>
                  <th className="px-3 py-2 text-right font-medium">Status</th>
                  <th className="px-3 py-2 text-right font-medium">Duration</th>
                  <th className="px-5 py-2 text-right font-medium">Cost</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {rows.map((r) => (
                  <tr
                    key={r.id}
                    onClick={() => onOpenProvider(r.provider)}
                    className={cn(
                      "cursor-pointer align-top transition-colors hover:bg-muted/50",
                      !r.ok && "bg-danger-tint/40",
                    )}
                  >
                    <td className="whitespace-nowrap px-5 py-2.5 text-[11px] text-muted-foreground">
                      {formatBucketFull(r.createdAt)}
                    </td>
                    <td className="px-3 py-2.5">
                      <span className="flex items-center gap-1.5">
                        <span className="font-medium">{r.providerName}</span>
                        <EnvBadge environment={r.environment} />
                      </span>
                    </td>
                    <td className="max-w-[20rem] px-3 py-2.5">
                      <p className="truncate font-mono text-[11px]">
                        <span className="text-muted-foreground">{r.method}</span> {r.endpoint || "—"}
                      </p>
                      {r.errorMessage && (
                        <p className="mt-0.5 line-clamp-2 text-[11px] text-danger" title={r.errorMessage}>
                          {r.errorMessage}
                        </p>
                      )}
                    </td>
                    <td className="px-3 py-2.5 text-right">
                      <span
                        className={cn(
                          "rounded-md px-1.5 py-px font-mono text-[10px] font-semibold",
                          r.ok ? "bg-success-tint text-success" : "bg-danger-tint text-danger",
                        )}
                      >
                        {r.status === 0 ? "ERR" : r.status}
                      </span>
                    </td>
                    <td className="px-3 py-2.5 text-right tabular-nums text-muted-foreground">
                      {formatMs(r.durationMs)}
                    </td>
                    <td className="px-5 py-2.5 text-right tabular-nums text-muted-foreground">
                      {r.costUsd > 0 ? formatUsd(r.costUsd) : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {totalPages > 1 && (
            <div className="flex items-center justify-between gap-2 border-t border-border px-5 py-3">
              <span className="text-xs text-muted-foreground tabular-nums">
                Page {page} of {totalPages}
              </span>
              <div className="flex gap-2">
                <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
                  Previous
                </Button>
                <Button variant="outline" size="sm" disabled={page >= totalPages} onClick={() => setPage((p) => p + 1)}>
                  Next
                </Button>
              </div>
            </div>
          )}
        </Card>
      )}
    </>
  );
}
