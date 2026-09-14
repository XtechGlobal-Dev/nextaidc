import { useEffect, useState } from "react";
import { BadgeDollarSign, Check, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ApiError, type ApplyPriceResult, type BrandPricing, type BrandPricingRow } from "@/lib/api";
import { formatMoney } from "@/lib/currency";

// Brand price list (base + addon = customer price). Shared by the platform view and the brand admin page; only who can edit the addon differs.

export function BrandPricingSection({
  pricing,
  canEdit,
  onSave,
  intro,
  onApply,
}: {
  pricing: BrandPricing | null;
  /** Whether this viewer may change addons at all. */
  canEdit: boolean;
  onSave: (planId: string, addonCents: number) => Promise<BrandPricingRow>;
  /** A line of context above the table, for the page that hosts it. */
  intro?: string;
  /** Platform owner only: move the plan's existing subscribers onto the
   *  brand's current Price. Absent for the brand admin, who can't re-bill. */
  onApply?: (planId: string) => Promise<ApplyPriceResult>;
}) {
  return (
    <Card className="space-y-4 p-5">
      <div>
        <h3 className="flex items-center gap-2 text-base font-semibold">
          <BadgeDollarSign className="size-4 text-primary" /> Plan pricing
        </h3>
        <p className="mt-1 text-sm text-muted-foreground">
          {intro ??
            "The platform sets each plan's base price. The addon is this brand's own charge on top; customers pay the total to the platform and the addon share is credited to the brand's wallet on every paid invoice."}
        </p>
      </div>

      {pricing === null ? (
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" /> Loading…
        </p>
      ) : pricing.rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">No active plans to price yet.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-muted-foreground">
                <th className="py-2 pr-4 font-medium">Plan</th>
                <th className="py-2 pr-4 font-medium">Base price</th>
                <th className="py-2 pr-4 font-medium">Addon</th>
                <th className="py-2 pr-4 font-medium">Customer pays</th>
                <th className="py-2 pr-4 font-medium">Stripe</th>
                <th className="py-2 text-right font-medium" />
              </tr>
            </thead>
            <tbody>
              {pricing.rows.map((row) => (
                <PricingRow
                  key={row.planId}
                  row={row}
                  canEdit={canEdit && pricing.addonEditable !== false}
                  maxAddonCents={pricing.maxAddonCents}
                  onSave={onSave}
                  onApply={onApply}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}

      {pricing && canEdit && pricing.addonEditable === false && (
        <p className="text-xs text-muted-foreground">
          Pricing for this brand is managed by the platform.
        </p>
      )}
      {pricing && typeof pricing.maxAddonCents === "number" && (
        <p className="text-xs text-muted-foreground">
          Addons are capped at {formatMoney(pricing.maxAddonCents, pricing.rows[0]?.currency)} per
          billing cycle.
        </p>
      )}
    </Card>
  );
}

function cycleLabel(row: BrandPricingRow): string {
  return row.intervalCount > 1 ? `every ${row.intervalCount} ${row.interval}s` : `per ${row.interval}`;
}

function PricingRow({
  row,
  canEdit,
  maxAddonCents,
  onSave,
  onApply,
}: {
  row: BrandPricingRow;
  canEdit: boolean;
  maxAddonCents: number | null;
  onSave: (planId: string, addonCents: number) => Promise<BrandPricingRow>;
  onApply?: (planId: string) => Promise<ApplyPriceResult>;
}) {
  const [current, setCurrent] = useState(row);
  const [draft, setDraft] = useState((row.addonCents / 100).toFixed(2));
  const [saving, setSaving] = useState(false);
  const [applying, setApplying] = useState(false);

  async function apply() {
    if (!onApply) return;
    setApplying(true);
    try {
      const r = await onApply(current.planId);
      const skipped = r.skipped.length
        ? ` ${r.skipped.length} skipped: ${r.skipped.map((s) => `${s.email} (${s.reason})`).join("; ")}`
        : "";
      toast.success(`${r.moved} moved, ${r.alreadyOn} already on this price.${skipped}`);
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "Couldn't apply the price.");
    } finally {
      setApplying(false);
    }
  }
  useEffect(() => {
    setCurrent(row);
    setDraft((row.addonCents / 100).toFixed(2));
  }, [row]);

  const parsed = Math.round((Number.parseFloat(draft || "0") || 0) * 100);
  const dirty = parsed !== current.addonCents;
  const overCap = typeof maxAddonCents === "number" && parsed > maxAddonCents;
  const preview = current.basePriceCents + Math.max(parsed, 0);

  async function save() {
    setSaving(true);
    try {
      const next = await onSave(current.planId, Math.max(parsed, 0));
      setCurrent(next);
      setDraft((next.addonCents / 100).toFixed(2));
      toast.success(
        next.addonCents
          ? `${next.planName} now sells at ${formatMoney(next.brandPriceCents, next.currency)}`
          : `${next.planName} sells at the platform price`,
      );
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "Couldn't save the addon.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <tr className="border-b border-border/60 last:border-0">
      <td className="py-2.5 pr-4">
        <div className="font-medium">{current.planName}</div>
        <div className="text-xs text-muted-foreground">{cycleLabel(current)}</div>
      </td>
      <td className="py-2.5 pr-4 tabular-nums">{formatMoney(current.basePriceCents, current.currency)}</td>
      <td className="py-2.5 pr-4">
        {canEdit ? (
          <Input
            type="number"
            min={0}
            step="0.01"
            inputMode="decimal"
            className="max-w-[8rem] tabular-nums"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            aria-label={`Addon for ${current.planName}`}
          />
        ) : (
          <span className="tabular-nums">{formatMoney(current.addonCents, current.currency)}</span>
        )}
      </td>
      <td className="py-2.5 pr-4 font-semibold tabular-nums">
        {formatMoney(dirty ? preview : current.brandPriceCents, current.currency)}
      </td>
      <td className="py-2.5 pr-4">
        {current.addonCents === 0 ? (
          <Badge variant="neutral">Platform price</Badge>
        ) : current.stripeLinked ? (
          <Badge variant="success">Brand price live</Badge>
        ) : (
          <Badge variant="warning" title="Link the plan to Stripe, then save the addon again.">
            {current.planLinked ? "Not linked" : "Plan not in Stripe"}
          </Badge>
        )}
      </td>
      <td className="py-2.5 text-right">
        {canEdit && (
          <Button size="sm" onClick={() => void save()} disabled={!dirty || saving || overCap || parsed < 0}>
            {saving ? <Loader2 className="size-4 animate-spin" /> : <Check className="size-4" />}
            Save
          </Button>
        )}
        {overCap && <div className="mt-1 text-[11px] text-danger">Over the cap</div>}
        {onApply && current.subscribers > 0 && (
          // Existing subscribers keep their Price until moved — no proration, new amount from next cycle.
          <Button
            size="sm"
            variant="outline"
            className="mt-1.5"
            onClick={() => void apply()}
            disabled={applying || dirty}
            title="Move this brand's existing subscribers on this plan to its current price, from their next cycle"
          >
            {applying ? <Loader2 className="size-4 animate-spin" /> : null}
            Apply to {current.subscribers} subscriber{current.subscribers === 1 ? "" : "s"}
          </Button>
        )}
      </td>
    </tr>
  );
}
