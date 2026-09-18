import { useEffect, useState } from "react";
import { Check, Lock, Package } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { api, type SubscriptionPlan } from "@/lib/api";
import { formatMoney } from "@/lib/currency";
import { cn } from "@/lib/utils";
import type { SetupDraft } from "./brandSetupDraft";

/** Which platform plans this brand may sell, as clickable tags: filled = offered, dashed = not offered.
 *  A plan the brand's customers are already on is locked: it stays offered whatever is clicked, and the
 *  server refuses a save that drops it. The pick is saved with the brand. */
export function BrandPlansTab({
  brandId,
  value,
  onChange,
}: {
  /** Absent while the brand is still loading — nothing is locked until it is known. */
  brandId?: string;
  value: Pick<SetupDraft, "planIds">;
  onChange: (patch: Partial<SetupDraft>) => void;
}) {
  const [plans, setPlans] = useState<SubscriptionPlan[] | null>(null);
  const [subscribers, setSubscribers] = useState<Record<string, number>>({});

  useEffect(() => {
    let active = true;
    api.admin.plans
      .list()
      .then((rows) => active && setPlans(rows.filter((p) => p.active)))
      .catch(() => active && setPlans([]));
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (!brandId) return;
    let active = true;
    api.super.brands
      .planSubscribers(brandId)
      .then((r) => active && setSubscribers(r.counts))
      .catch(() => active && setSubscribers({}));
    return () => {
      active = false;
    };
  }, [brandId]);

  const picked = new Set(value.planIds);
  const locked = new Set(Object.keys(subscribers).filter((id) => subscribers[id] > 0));
  const isLocked = (id: string) => locked.has(id);

  // A non-empty pick always carries the locked plans; an empty pick offers every plan, so nothing to add.
  const withLocked = (ids: string[]) =>
    ids.length === 0 ? ids : [...ids, ...[...locked].filter((id) => !ids.includes(id))];
  const set = (ids: string[]) => onChange({ planIds: withLocked(ids) });

  const toggle = (id: string) => {
    if (picked.has(id)) {
      if (isLocked(id)) return;
      set(value.planIds.filter((p) => p !== id));
    } else {
      set([...value.planIds, id]);
    }
  };

  // A pick that no longer matches an active plan (the plan was retired) still shows, so it can be taken off.
  const activeIds = new Set((plans ?? []).map((p) => p.id));
  const stale = value.planIds.filter((id) => !activeIds.has(id));
  const offeringAll = value.planIds.length === 0;
  const customers = (n: number) => `${n} customer${n === 1 ? "" : "s"}`;

  return (
    <Card className="space-y-5 p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="flex items-center gap-2 text-base font-semibold">
            <Package className="size-4 text-primary" /> Plans this brand sells
          </h3>
          <p className="mt-1 text-sm text-muted-foreground">
            Click a plan to offer it or take it away. The brand's admin sees only the offered plans on
            Default plans and its subscribe page. With nothing picked, every active platform plan is
            offered. A plan this brand's customers are on is locked until they leave it.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={!plans || plans.length === 0 || plans.every((p) => picked.has(p.id))}
            onClick={() => plans && set(plans.map((p) => p.id))}
          >
            Select all
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={value.planIds.length === 0}
            onClick={() => onChange({ planIds: [] })}
          >
            Clear
          </Button>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        {offeringAll ? (
          <Badge variant="neutral">Offering every active plan</Badge>
        ) : (
          <Badge variant="primary">
            {value.planIds.length - stale.length} of {plans?.length ?? 0} offered
          </Badge>
        )}
        <span className="inline-flex items-center gap-1.5">
          <span className="inline-block size-2.5 rounded-sm border border-primary bg-primary-tint" /> Offered
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="inline-block size-2.5 rounded-sm border border-dashed border-border" /> Not offered
        </span>
        {locked.size > 0 && (
          <span className="inline-flex items-center gap-1.5">
            <Lock className="size-3" /> Has customers — can't be taken away
          </span>
        )}
      </div>

      {plans === null ? (
        <p className="text-sm text-muted-foreground">Loading plans…</p>
      ) : plans.length === 0 ? (
        <p className="text-sm text-muted-foreground">No active plans on the platform yet.</p>
      ) : (
        <div className="flex flex-wrap gap-2">
          {plans.map((p) => {
            const lockedPlan = isLocked(p.id);
            // Locked plans read as offered even before a pick names them: with an empty pick they are sold already.
            const on = picked.has(p.id) || (lockedPlan && offeringAll);
            const count = subscribers[p.id] ?? 0;
            return (
              <button
                key={p.id}
                type="button"
                aria-pressed={on}
                aria-disabled={lockedPlan || undefined}
                title={
                  lockedPlan
                    ? `${customers(count)} of this brand are on ${p.displayName} — it stays offered until they leave it.`
                    : undefined
                }
                onClick={() => toggle(p.id)}
                className={cn(
                  "group inline-flex items-center gap-2 rounded-full border px-3 py-1.5 text-sm transition-colors focus-visible:focus-ring",
                  on
                    ? "border-primary bg-primary-tint text-primary"
                    : "border-dashed border-border bg-background text-muted-foreground hover:border-primary/50 hover:text-foreground",
                  lockedPlan && "cursor-not-allowed",
                )}
              >
                <span
                  className={cn(
                    "grid size-4 shrink-0 place-items-center rounded-full border",
                    on ? "border-primary bg-primary text-primary-foreground" : "border-current opacity-50",
                  )}
                >
                  {lockedPlan ? <Lock className="size-2.5" /> : on && <Check className="size-3" />}
                </span>
                <span className="font-medium">{p.displayName}</span>
                <span className={cn("text-xs", on ? "text-primary/80" : "text-muted-foreground")}>
                  {formatMoney(p.priceCents, p.currency)} / {p.intervalCount > 1 ? `${p.intervalCount} ` : ""}
                  {p.interval}
                </span>
                {count > 0 && (
                  <span className="rounded-full bg-primary/10 px-1.5 py-0.5 text-[11px] font-medium text-primary">
                    {customers(count)}
                  </span>
                )}
              </button>
            );
          })}
          {stale.map((id) => (
            <button
              key={id}
              type="button"
              aria-pressed
              onClick={() => toggle(id)}
              title="This plan is no longer active — click to take it off"
              className="inline-flex items-center gap-2 rounded-full border border-warning/50 bg-warning-tint px-3 py-1.5 text-sm text-warning"
            >
              <Check className="size-3.5" />
              <span className="font-medium">Retired plan</span>
              <span className="text-xs opacity-80">{id}</span>
            </button>
          ))}
        </div>
      )}
    </Card>
  );
}
