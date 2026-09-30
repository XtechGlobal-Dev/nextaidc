import { useCallback, useEffect, useState, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { AlertTriangle, BadgeCheck, Clock, CreditCard, Layers, Puzzle, Receipt, TrendingUp } from "lucide-react";
import { toast } from "sonner";
import { PageHeader } from "@/components/layout/PageHeader";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DataCard, DataCardGrid, DataCardHeader, DataCardPills, CardField } from "@/components/ui/data-card";
import { BrandMark } from "@/components/brand/BrandLookPickers";
import { api, ApiError, type BrandBillingOverview, type BrandBillingRow } from "@/lib/api";
import { formatMoney } from "@/lib/currency";
import { billingStatusMeta } from "@/lib/brandBilling";
import { BrandAddonsDialog } from "./BrandAddonsDialog";

// Brand Subscriptions: what every BRAND pays the PLATFORM — its brand plan, add-ons, and whether it's paid.
// The brand plan catalog and the add-on list are managed from the two buttons up top. This is the platform's
// income from brands; the plans brands sell their own customers live under Plans and don't appear here.

const fmtDate = (iso: string | null) =>
  iso ? new Date(iso).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" }) : "—";

export default function AdminBrandSubscriptionsPage() {
  const navigate = useNavigate();
  const [data, setData] = useState<BrandBillingOverview | null>(null);
  const [addonsOpen, setAddonsOpen] = useState(false);

  const load = useCallback(async () => {
    try {
      setData(await api.super.brandSubscriptions());
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "Couldn't load brand subscriptions");
      setData({ rows: [], summary: { paying: 0, awaiting: 0, failing: 0, mrr: [] } });
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const open = (r: BrandBillingRow) => navigate(`/dashboard/admin/brands/${r.brandId}?tab=billing`);

  const renderPlan = (r: BrandBillingRow) =>
    r.plan ? (
      <span className="inline-flex items-center gap-1.5">
        {r.plan.name}
        {!r.plan.active && <Badge variant="neutral" className="text-[10px]">Archived</Badge>}
      </span>
    ) : r.custom ? (
      <span className="text-muted-foreground">Custom</span>
    ) : (
      <span className="text-muted-foreground">—</span>
    );

  const renderStatus = (r: BrandBillingRow) => {
    const meta = billingStatusMeta(r.billingStatus);
    return (
      <span className="flex flex-wrap items-center gap-1.5">
        <Badge variant={meta.variant}>{meta.label}</Badge>
        {r.serviceHold && <Badge variant="danger">AI paused</Badge>}
      </span>
    );
  };

  const renderAddOns = (r: BrandBillingRow) =>
    r.addOns.length ? (
      <span className="flex flex-wrap gap-1">
        {r.addOns.map((a) => (
          <Badge key={a.id} variant="primary" className="text-[10px]" title={`${formatMoney(a.priceCents, r.currency)}/mo`}>
            {a.label}
          </Badge>
        ))}
      </span>
    ) : (
      <span className="text-muted-foreground">—</span>
    );

  const mark = (r: BrandBillingRow) => (
    <BrandMark logoUrl={r.logoLightUrl} name={r.name} primary={r.primaryColor} accent={r.accentColor} className="size-9 rounded-lg text-xs" />
  );

  return (
    <div>
      <PageHeader
        title="Brand Subscriptions"
        subtitle="What each brand pays the platform — its brand plan and add-ons. Separate from the plans brands sell their customers."
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="outline" onClick={() => setAddonsOpen(true)}>
              <Puzzle className="size-4" /> Add-ons
            </Button>
            <Button onClick={() => navigate("/dashboard/admin/brand-plans")}>
              <Layers className="size-4" /> Brand plans
            </Button>
          </div>
        }
      />

      <div className="mb-5 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Tile icon={BadgeCheck} label="Paying brands" value={data ? String(data.summary.paying) : "—"} />
        <Tile
          icon={TrendingUp}
          label="Monthly revenue"
          value={
            data
              ? data.summary.mrr.length
                ? data.summary.mrr.map((m) => formatMoney(m.cents, m.currency)).join(" · ")
                : formatMoney(0, "usd")
              : "—"
          }
          hint="From brands that are paid up"
        />
        <Tile icon={Clock} label="Awaiting first payment" value={data ? String(data.summary.awaiting) : "—"} />
        <Tile icon={AlertTriangle} label="Payment problems" value={data ? String(data.summary.failing) : "—"} hint="Failed or canceled" />
      </div>

      {data === null ? (
        <Card className="overflow-hidden">
          <div className="divide-y divide-border/60">
            {Array.from({ length: 3 }).map((_, i) => (
              <div key={i} className="flex items-center gap-3 px-4 py-4">
                <div className="size-9 shrink-0 animate-pulse rounded-lg bg-muted" />
                <div className="h-3.5 w-48 animate-pulse rounded bg-muted" />
              </div>
            ))}
          </div>
        </Card>
      ) : data.rows.length === 0 ? (
        <Card className="flex flex-col items-center gap-2 py-16 text-center">
          <Receipt className="size-8 text-muted-foreground" />
          <p className="text-sm font-medium">No brands yet</p>
          <p className="max-w-md text-sm text-muted-foreground">
            Create a brand plan first — brands requesting setup choose one, and pay for it once you complete
            their setup.
          </p>
          <Button className="mt-2" onClick={() => navigate("/dashboard/admin/brand-plans")}>
            <Layers className="size-4" /> Brand plans
          </Button>
        </Card>
      ) : (
        <>
          <Card className="hidden overflow-hidden md:block">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-muted-foreground">
                    <th className="px-4 py-3 font-medium">Brand</th>
                    <th className="px-4 py-3 font-medium">Plan</th>
                    <th className="px-4 py-3 font-medium">Add-ons</th>
                    <th className="px-4 py-3 text-right font-medium">Monthly</th>
                    <th className="px-4 py-3 font-medium">Status</th>
                    <th className="px-4 py-3 font-medium">Renews</th>
                    <th className="px-4 py-3 font-medium">Card</th>
                  </tr>
                </thead>
                <tbody>
                  {data.rows.map((r) => (
                    <tr
                      key={r.brandId}
                      onClick={() => open(r)}
                      className="cursor-pointer border-b border-border/60 transition-colors last:border-0 hover:bg-primary-tint-soft"
                    >
                      <td className="max-w-[260px] px-4 py-3">
                        <div className="flex items-center gap-3">
                          {mark(r)}
                          <div className="min-w-0">
                            <p className="truncate font-medium">{r.name}</p>
                            <p className="truncate font-mono text-xs text-muted-foreground">{r.slug}</p>
                          </div>
                        </div>
                      </td>
                      <td className="px-4 py-3">{renderPlan(r)}</td>
                      <td className="max-w-[220px] px-4 py-3">{renderAddOns(r)}</td>
                      <td className="whitespace-nowrap px-4 py-3 text-right tabular-nums">
                        {r.monthlyTotalCents ? formatMoney(r.monthlyTotalCents, r.currency) : <span className="text-muted-foreground">—</span>}
                      </td>
                      <td className="px-4 py-3">{renderStatus(r)}</td>
                      <td className="whitespace-nowrap px-4 py-3 text-muted-foreground">{fmtDate(r.currentPeriodEnd)}</td>
                      <td className="whitespace-nowrap px-4 py-3 text-muted-foreground">
                        {r.card ? (
                          <span className="inline-flex items-center gap-1.5 capitalize">
                            <CreditCard className="size-3.5" /> {r.card.brand} •••• {r.card.last4}
                          </span>
                        ) : (
                          "—"
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>

          <div className="space-y-3 md:hidden">
            {data.rows.map((r) => (
              <DataCard key={r.brandId} onClick={() => open(r)}>
                <DataCardHeader lead={mark(r)} title={r.name} subtitle={r.plan?.name ?? (r.custom ? "Custom" : "No plan")} />
                <DataCardPills>{renderStatus(r)}</DataCardPills>
                <DataCardGrid>
                  <CardField label="Monthly">
                    {r.monthlyTotalCents ? formatMoney(r.monthlyTotalCents, r.currency) : "—"}
                  </CardField>
                  <CardField label="Renews">{fmtDate(r.currentPeriodEnd)}</CardField>
                  <CardField label="Add-ons">{r.addOns.length ? r.addOns.map((a) => a.label).join(", ") : "—"}</CardField>
                </DataCardGrid>
              </DataCard>
            ))}
          </div>
        </>
      )}

      <BrandAddonsDialog
        open={addonsOpen}
        onOpenChange={setAddonsOpen}
        onSaved={() => void load()}
      />
    </div>
  );
}

function Tile({ icon: Icon, label, value, hint }: { icon: typeof Receipt; label: string; value: string; hint?: ReactNode }) {
  return (
    <Card className="p-4">
      <p className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
        <Icon className="size-3.5" /> {label}
      </p>
      <p className="mt-1.5 truncate text-2xl font-semibold tabular-nums">{value}</p>
      {hint && <p className="mt-0.5 text-xs text-muted-foreground">{hint}</p>}
    </Card>
  );
}
