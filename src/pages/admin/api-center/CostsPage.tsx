import { Link } from "react-router-dom";
import { DollarSign, Info, Settings2 } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { CardSkeleton } from "@/components/ui/skeleton";
import { TimeSeriesChart } from "@/components/charts/Charts";
import { compactNumber, formatUsd } from "@/components/charts/primitives";
import { useApiCenter } from "@/components/admin/api-center/ApiCenterContext";
import { ApiCenterEmpty, SectionHeading, SummaryBar } from "@/components/admin/api-center/shared";
import { sectionPath } from "@/components/admin/api-center/sections";
import type { CostConfidence } from "@/types/apiCenter";

/* ------------------------------------------------------------------ *
 *  Costs — what the integrations are costing, and how much to trust it.
 *
 *  One chart and one table. The earlier version had three charts saying roughly
 *  the same thing; the by-category breakdown is gone because with a dozen
 *  providers the by-provider table already answers it, and a second ranking of
 *  the same money is noise.
 *
 *  Every figure is an ESTIMATE and the screen says so once, prominently, plus a
 *  per-row confidence badge. Providers where the tracer records real units are
 *  arithmetic; the rest are calls x list price. Presenting those as one
 *  unqualified number would be the most harmful thing this screen could do.
 * ------------------------------------------------------------------ */

const CONFIDENCE: Record<CostConfidence, { label: string; variant: "success" | "warning" | "neutral" }> = {
  metered: { label: "Measured", variant: "success" },
  estimated: { label: "Estimated", variant: "warning" },
  none: { label: "No price", variant: "neutral" },
};

export default function ApiCenterCostsPage() {
  const { snapshot, view, loading, visibleProviders, setOpenProvider } = useApiCenter();

  if (loading && !snapshot) return <CardSkeleton rows={6} />;
  if (!snapshot || !view) return null;

  // Filtered totals and series — see useApiCenter().view.
  const { totals, series } = view;
  const { range } = snapshot;
  const priced = visibleProviders.filter((p) => p.costUsd > 0).sort((a, b) => b.costUsd - a.costUsd);
  const unpriced = visibleProviders.filter((p) => p.requests > 0 && p.costConfidence === "none");

  return (
    <div className="space-y-4">
      <SummaryBar
        stats={[
          { label: `Spend · ${range.label.replace("Last ", "")}`, value: formatUsd(totals.costUsd) },
          { label: "Month to date", value: formatUsd(totals.costMonthUsd) },
          { label: "Priced providers", value: `${priced.length}/${visibleProviders.filter((p) => p.requests > 0).length}` },
        ]}
      />

      <p className="flex items-start gap-2 rounded-lg border border-border bg-warm p-3 text-xs text-muted-foreground">
        <Info className="mt-px size-4 shrink-0 text-primary" />
        <span>
          These are <strong className="font-semibold text-foreground">estimates, not invoices</strong>.{" "}
          <em>Measured</em> rows are costed from real billable units the tracer recorded; <em>Estimated</em> rows are
          call count multiplied by a list price — right order of magnitude for flat-rate endpoints, wrong for anything
          usage-priced. Reconcile against the vendor's billing before acting on a number here.
        </span>
      </p>

      {totals.costUsd === 0 ? (
        <ApiCenterEmpty
          icon={DollarSign}
          title="No cost recorded in this window"
          message="Cost appears once traffic flows through a provider that has a unit price configured."
          action={
            <Button asChild variant="outline" size="sm">
              <Link to={sectionPath("settings")}>
                <Settings2 className="size-4" /> Set unit prices
              </Link>
            </Button>
          }
        />
      ) : (
        <>
          <Card className="p-5">
            <SectionHeading title="Spend over time" hint={`Estimated cost per bucket · ${range.label.toLowerCase()}`} />
            <TimeSeriesChart
              labels={series.map((s) => s.t)}
              bucketSec={range.bucketSec}
              height={200}
              format={(v) => formatUsd(v, { compact: true })}
              series={[
                {
                  key: "cost",
                  label: "Estimated cost",
                  values: series.map((s) => s.costUsd),
                  color: "var(--color-chart-3)",
                  area: true,
                },
              ]}
              emptyMessage="No priced traffic in this window"
            />
          </Card>

          <Card className="overflow-hidden">
            <SectionHeading
              title="By provider"
              className="p-5 pb-0"
              hint="Highest estimated spend first"
              actions={
                <Button asChild variant="ghost" size="sm">
                  <Link to={sectionPath("settings")}>
                    <Settings2 className="size-4" /> Edit prices
                  </Link>
                </Button>
              }
            />
            <div className="overflow-x-auto">
              <table className="w-full min-w-[40rem] text-sm">
                <thead>
                  <tr className="border-b border-border text-left text-[11px] uppercase tracking-wide text-muted-foreground">
                    <th className="px-5 py-2 font-medium">Provider</th>
                    <th className="px-3 py-2 font-medium">Confidence</th>
                    <th className="px-3 py-2 text-right font-medium">Calls</th>
                    <th className="px-3 py-2 text-right font-medium">Units</th>
                    <th className="px-3 py-2 text-right font-medium">Unit price</th>
                    <th className="px-5 py-2 text-right font-medium">Cost</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {priced.map((p) => {
                    const badge = CONFIDENCE[p.costConfidence];
                    // A bar behind the row: ranking at a glance without a second
                    // chart repeating the same numbers.
                    const share = (p.costUsd / Math.max(totals.costUsd, 1e-9)) * 100;
                    return (
                      <tr
                        key={p.id}
                        onClick={() => setOpenProvider(p.id)}
                        className="relative cursor-pointer transition-colors hover:bg-muted/50"
                      >
                        <td className="px-5 py-2.5">
                          <p className="font-medium">{p.name}</p>
                          <div className="mt-1 h-1 w-24 overflow-hidden rounded-full bg-muted">
                            <div
                              className="h-full rounded-full bg-[var(--color-chart-3)]"
                              style={{ width: `${Math.max(2, share)}%` }}
                            />
                          </div>
                        </td>
                        <td className="px-3 py-2.5">
                          <Badge variant={badge.variant}>{badge.label}</Badge>
                        </td>
                        <td className="px-3 py-2.5 text-right tabular-nums text-muted-foreground">
                          {compactNumber(p.requests)}
                        </td>
                        <td className="px-3 py-2.5 text-right tabular-nums text-muted-foreground">
                          {p.units > 0 ? compactNumber(p.units) : "—"}
                          <span className="block text-[10px]">{p.unitLabel}</span>
                        </td>
                        <td className="px-3 py-2.5 text-right tabular-nums text-muted-foreground">
                          {p.unitCostUsd != null ? `$${p.unitCostUsd}` : "—"}
                        </td>
                        <td className="px-5 py-2.5 text-right font-semibold tabular-nums">{formatUsd(p.costUsd)}</td>
                      </tr>
                    );
                  })}
                </tbody>
                <tfoot>
                  <tr className="border-t border-border bg-muted/40">
                    <td className="px-5 py-2.5 text-xs font-semibold" colSpan={5}>
                      Total · {range.label.toLowerCase()}
                    </td>
                    <td className="px-5 py-2.5 text-right text-sm font-bold tabular-nums">
                      {formatUsd(totals.costUsd)}
                    </td>
                  </tr>
                </tfoot>
              </table>
            </div>
          </Card>
        </>
      )}

      {unpriced.length > 0 && (
        <p className="text-xs text-muted-foreground">
          No price configured for{" "}
          {unpriced.map((p, i) => (
            <span key={p.id}>
              {i > 0 && ", "}
              <button
                type="button"
                onClick={() => setOpenProvider(p.id)}
                className="font-medium text-primary hover:underline"
              >
                {p.name}
              </button>
            </span>
          ))}
          {" — "}their traffic contributes nothing to the totals above.
        </p>
      )}
    </div>
  );
}
