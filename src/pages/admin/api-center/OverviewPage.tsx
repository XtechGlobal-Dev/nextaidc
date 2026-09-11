import { Link } from "react-router-dom";
import { toast } from "sonner";
import * as React from "react";
import { ArrowRight, Bell, CheckCircle2, Plug } from "lucide-react";
import { cn } from "@/lib/utils";
import { api, ApiError } from "@/lib/api";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { CardSkeleton } from "@/components/ui/skeleton";
import { TimeSeriesChart } from "@/components/charts/Charts";
import { compactNumber, formatPct, formatUsd, timeAgo } from "@/components/charts/primitives";
import { useApiCenter } from "@/components/admin/api-center/ApiCenterContext";
import {
  ApiCenterEmpty,
  HEALTH_META,
  HealthDot,
  HealthPill,
  SectionHeading,
  SummaryBar,
} from "@/components/admin/api-center/shared";
import { sectionPath } from "@/components/admin/api-center/sections";
import type { AlertEvent } from "@/types/apiCenter";

/* ------------------------------------------------------------------ *
 *  Overview — deliberately the calmest screen in the admin area.
 *
 *  Four blocks, in the order an operator actually needs them:
 *    1. one line saying whether anything is wrong
 *    2. what is wrong, ranked
 *    3. any alert that fired
 *    4. one chart for context
 *
 *  Everything else moved to Providers, Activity and Costs. A dashboard that
 *  opens with a wall of tiles makes people stop reading it, which defeats the
 *  entire point of having one.
 * ------------------------------------------------------------------ */

export default function ApiCenterOverviewPage() {
  const { snapshot, view, loading, visibleProviders, setOpenProvider, refresh } = useApiCenter();
  const [alerts, setAlerts] = React.useState<AlertEvent[]>([]);
  const [busy, setBusy] = React.useState<string | null>(null);

  // Alerts are their own small fetch rather than part of the snapshot: they
  // change on a different clock, and evaluating them on read keeps the board
  // current the moment someone opens this page.
  React.useEffect(() => {
    let active = true;
    (async () => {
      try {
        const res = await api.admin.apiCenter.alerts("open");
        if (active) setAlerts(res.events);
      } catch {
        /* the badge is supporting information — never block the page for it */
      }
    })();
    return () => {
      active = false;
    };
  }, [snapshot?.generatedAt]);

  const resolveAlert = async (id: string) => {
    setBusy(id);
    try {
      setAlerts(await api.admin.apiCenter.resolveAlert(id));
      void refresh();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "Couldn't resolve that alert");
    } finally {
      setBusy(null);
    }
  };

  if (loading && !snapshot) return <CardSkeleton rows={6} />;
  if (!snapshot || !view) return null;

  // Totals and series come from `view`, not the raw snapshot, so filtering the
  // fleet moves the headline numbers and the chart with the list below them.
  const { totals, series } = view;
  const { range } = snapshot;
  const attention = visibleProviders.filter((p) => p.attentionScore > 0);
  const hasTraffic = totals.requests > 0;

  return (
    <div className="space-y-5">
      {/* ------------------------ 1. The one line --------------------- */}
      <SummaryBar
        stats={[
          {
            label: "Integrations",
            value: (
              <span className="flex items-center gap-2">
                {totals.connected}/{totals.wired}
                {/* Idle is shown alongside the rest so the dots reconcile with
                    the connected count — a connected provider that simply hasn't
                    been called in this window is neither healthy-with-traffic
                    nor a problem, and omitting it made the numbers look wrong. */}
                <span className="flex items-center gap-1.5 text-xs font-normal text-muted-foreground">
                  <HealthDot health="healthy" /> {totals.healthy}
                  {totals.degraded > 0 && (
                    <>
                      <HealthDot health="degraded" /> {totals.degraded}
                    </>
                  )}
                  {totals.failed + totals.disconnected > 0 && (
                    <>
                      <HealthDot health="failed" /> {totals.failed + totals.disconnected}
                    </>
                  )}
                  {totals.idle > 0 && (
                    <>
                      <HealthDot health="idle" /> {totals.idle}
                    </>
                  )}
                </span>
              </span>
            ),
            tone: totals.failed + totals.disconnected > 0 ? "danger" : totals.degraded > 0 ? "warning" : "success",
          },
          {
            label: "Availability",
            value: hasTraffic ? formatPct(totals.uptimePct) : "—",
            tone: !hasTraffic ? "neutral" : totals.uptimePct >= 99 ? "success" : totals.uptimePct >= 95 ? "warning" : "danger",
          },
          { label: `Requests · ${range.label.replace("Last ", "")}`, value: compactNumber(totals.requests) },
          { label: "Spend · month", value: formatUsd(totals.costMonthUsd, { compact: true }) },
        ]}
      />

      {/* --------------------- 2. What needs you ---------------------- */}
      <section>
        <SectionHeading
          title="Needs attention"
          actions={
            attention.length > 3 && (
              <Button asChild variant="ghost" size="sm">
                <Link to={sectionPath("providers")}>
                  See all {attention.length} <ArrowRight className="size-4" />
                </Link>
              </Button>
            )
          }
        />
        {attention.length === 0 ? (
          <Card className="flex items-center gap-3 p-4">
            <span className="grid size-9 shrink-0 place-items-center rounded-full bg-success-tint text-success">
              <CheckCircle2 className="size-5" />
            </span>
            <div>
              <p className="text-sm font-semibold">Everything is healthy</p>
              <p className="text-xs text-muted-foreground">
                Nothing is disconnected, failing, slow, or near a quota limit.
              </p>
            </div>
          </Card>
        ) : (
          <ul className="space-y-2">
            {attention.slice(0, 5).map((p) => (
              <li key={p.id}>
                <button
                  type="button"
                  onClick={() => setOpenProvider(p.id)}
                  className={cn(
                    "flex w-full items-center gap-3 rounded-xl border bg-card p-3 text-left transition-colors",
                    "hover:border-primary/40 hover:bg-primary-tint-soft focus-visible:focus-ring",
                    p.health === "failed" || p.health === "disconnected" ? "border-danger/40" : "border-warning/40",
                  )}
                >
                  <HealthDot health={p.health} className="size-2.5" />
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-sm font-semibold">{p.name}</span>
                      <HealthPill health={p.health} size="xs" />
                    </div>
                    <p className="mt-0.5 truncate text-xs text-muted-foreground">
                      {p.attentionReasons.join(" · ")}
                    </p>
                  </div>
                  <ArrowRight className="size-4 shrink-0 text-muted-foreground" />
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* ------------------------- 3. Alerts -------------------------- */}
      {alerts.length > 0 && (
        <section>
          <SectionHeading title={`Open alerts (${alerts.length})`} />
          <ul className="space-y-2">
            {alerts.slice(0, 4).map((a) => (
              <li
                key={a.id}
                className={cn(
                  "flex flex-wrap items-center gap-3 rounded-xl border bg-card p-3",
                  a.severity === "critical" ? "border-danger/40" : "border-warning/40",
                )}
              >
                <span
                  className={cn(
                    "grid size-8 shrink-0 place-items-center rounded-full",
                    a.severity === "critical" ? "bg-danger-tint text-danger" : "bg-warning-tint text-warning",
                  )}
                >
                  <Bell className="size-4" />
                </span>
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium">{a.message}</p>
                  <p className="text-[11px] text-muted-foreground">Raised {timeAgo(a.createdAt)}</p>
                </div>
                <Button variant="ghost" size="sm" onClick={() => resolveAlert(a.id)} disabled={busy === a.id}>
                  Resolve
                </Button>
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* -------------------------- 4. Traffic ------------------------ */}
      <Card className="p-5">
        <SectionHeading
          title="Traffic"
          hint={`All providers · ${range.label.toLowerCase()}`}
          actions={
            <Button asChild variant="ghost" size="sm">
              <Link to={sectionPath("activity")}>
                Details <ArrowRight className="size-4" />
              </Link>
            </Button>
          }
        />
        <TimeSeriesChart
          labels={series.map((s) => s.t)}
          bucketSec={range.bucketSec}
          height={200}
          series={[
            {
              key: "requests",
              label: "Requests",
              values: series.map((s) => s.requests),
              color: "var(--color-primary)",
              area: true,
            },
            {
              key: "errors",
              label: "Errors",
              values: series.map((s) => s.errors),
              color: HEALTH_META.failed.solid,
            },
          ]}
          emptyMessage="No API traffic recorded in this window yet"
        />
      </Card>

      {!hasTraffic && totals.connected === 0 && (
        <ApiCenterEmpty
          icon={Plug}
          title="No integrations connected yet"
          message="Once credentials are saved and the platform starts calling third-party APIs, every screen here fills in automatically. Nothing needs configuring — tracing is on by default."
          action={
            <Button asChild variant="outline" size="sm">
              <Link to={sectionPath("providers")}>Review providers</Link>
            </Button>
          }
        />
      )}
    </div>
  );
}
