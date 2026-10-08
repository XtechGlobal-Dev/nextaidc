import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Loader2, PhoneCall, Receipt, Timer, TrendingUp, Users } from "lucide-react";
import { Card } from "@/components/ui/card";
import { TimeSeriesChart } from "@/components/charts/Charts";
import { compactNumber } from "@/components/charts/primitives";
import { api, ApiError, type Brand, type BrandAnalytics } from "@/lib/api";
import { formatMoney } from "@/lib/currency";
import { cn } from "@/lib/utils";

// One brand's numbers for the super admin: stat tiles for the headline figures, then one chart per
// measure (calls, minutes, money and headcount each get their own scale — never two on one axis).

type Window = 7 | 30 | 90 | 365;
const WINDOWS: { days: Window; label: string }[] = [
  { days: 7, label: "7 days" },
  { days: 30, label: "30 days" },
  { days: 90, label: "90 days" },
  { days: 365, label: "12 months" },
];

const DAY_SEC = 86_400;

export function BrandAnalyticsTab({ brand }: { brand: Brand }) {
  const [days, setDays] = useState<Window>(30);
  const [data, setData] = useState<BrandAnalytics | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    let active = true;
    setError("");
    api.super.brands
      .analytics(brand.id, days)
      .then((d) => active && setData(d))
      .catch((e) => active && setError(e instanceof ApiError ? e.message : "Failed to load analytics"));
    return () => {
      active = false;
    };
  }, [brand.id, days]);

  // Noon UTC per day, so no timezone west of Greenwich labels a day as the one before.
  const labels = useMemo(() => (data?.series ?? []).map((d) => `${d.day}T12:00:00Z`), [data]);
  const money = (cents: number) => formatMoney(cents, data?.currency);

  return (
    <div className="space-y-5">
      {/* Filters: one row, above everything they change. */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="inline-flex rounded-xl border border-border bg-card p-1" role="radiogroup" aria-label="Time range">
          {WINDOWS.map((w) => (
            <button
              key={w.days}
              type="button"
              role="radio"
              aria-checked={days === w.days}
              onClick={() => setDays(w.days)}
              className={cn(
                "rounded-lg px-3 py-1.5 text-xs font-medium transition-colors",
                days === w.days ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground",
              )}
            >
              {w.label}
            </button>
          ))}
        </div>
        {data?.current.asOf && (
          <p className="text-xs text-muted-foreground">
            Headcounts as of {new Date(data.current.asOf).toLocaleString()} · money is live
          </p>
        )}
      </div>

      {error ? (
        <Card className="p-6 text-sm text-danger">{error}</Card>
      ) : !data ? (
        <Card className="flex justify-center py-16 text-muted-foreground">
          <Loader2 className="size-6 animate-spin" />
        </Card>
      ) : (
        <>
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            <Tile icon={Users} label="Customers" value={data.current.customers.toLocaleString()}>
              {data.current.active.toLocaleString()} paying · {data.current.trialing.toLocaleString()} on trial
            </Tile>
            <Tile icon={PhoneCall} label="Calls" value={data.totals.calls.toLocaleString()}>
              {data.current.callsTotal.toLocaleString()} all time
            </Tile>
            <Tile icon={Timer} label="Call minutes" value={data.totals.minutes.toLocaleString()}>
              {data.current.minutesTotal.toLocaleString()} all time
            </Tile>
            <Tile icon={TrendingUp} label="Customer payments" value={money(data.totals.revenueCents)}>
              What {brand.name}&rsquo;s customers paid in this window
            </Tile>
            <Tile icon={Receipt} label="Platform share" value={money(data.totals.platformCents)}>
              {money(data.totals.brandCents)} went to the brand
            </Tile>
          </div>

          <div className="grid gap-5 lg:grid-cols-2">
            <ChartCard title="Calls per day">
              <TimeSeriesChart
                labels={labels}
                bucketSec={DAY_SEC}
                series={[{ key: "calls", label: "Calls", values: data.series.map((d) => d.calls), color: "var(--color-chart-1)", area: true }]}
                emptyMessage="No calls in this window"
              />
            </ChartCard>
            <ChartCard title="Call minutes per day">
              <TimeSeriesChart
                labels={labels}
                bucketSec={DAY_SEC}
                series={[{ key: "minutes", label: "Minutes", values: data.series.map((d) => d.minutes), color: "var(--color-chart-1)", area: true }]}
                emptyMessage="No call minutes in this window"
              />
            </ChartCard>
            <ChartCard title={`Customer payments per day (${data.currency.toUpperCase()})`}>
              <TimeSeriesChart
                labels={labels}
                bucketSec={DAY_SEC}
                format={(v) => money(v)}
                series={[
                  { key: "revenue", label: "Paid by customers", values: data.series.map((d) => d.revenueCents), color: "var(--color-chart-1)", format: money },
                  { key: "platform", label: "Platform share", values: data.series.map((d) => d.platformCents), color: "var(--color-chart-2)", format: money },
                ]}
                emptyMessage="No payments in this window"
              />
            </ChartCard>
            <ChartCard title="Customers">
              <TimeSeriesChart
                labels={labels}
                bucketSec={DAY_SEC}
                format={compactNumber}
                series={[
                  { key: "customers", label: "All customers", values: data.series.map((d) => d.customers), color: "var(--color-chart-1)" },
                  { key: "active", label: "Paying", values: data.series.map((d) => d.active), color: "var(--color-chart-2)" },
                ]}
                emptyMessage="No customers yet"
              />
            </ChartCard>
          </div>
        </>
      )}
    </div>
  );
}

function Tile({
  icon: Icon,
  label,
  value,
  children,
}: {
  icon: typeof Users;
  label: string;
  value: string;
  children?: ReactNode;
}) {
  return (
    <Card className="p-4">
      <p className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
        <Icon className="size-3.5" /> {label}
      </p>
      <p className="mt-1.5 truncate text-2xl font-semibold tabular-nums">{value}</p>
      {children && <p className="mt-1 text-xs text-muted-foreground">{children}</p>}
    </Card>
  );
}

function ChartCard({ title, children }: { title: string; children: ReactNode }) {
  return (
    <Card className="p-5">
      <h3 className="mb-3 text-sm font-semibold">{title}</h3>
      {children}
    </Card>
  );
}
