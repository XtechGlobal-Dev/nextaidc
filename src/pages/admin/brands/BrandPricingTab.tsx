import { useCallback, useEffect, useState } from "react";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { api, type Brand, type BrandPricing, type BrandWallet } from "@/lib/api";
import { BrandPricingSection } from "./BrandPricingSection";
import { BrandWalletSection } from "./BrandWalletSection";
import { BrandLedgerCard } from "./BrandLedgerCard";
import type { SetupDraft } from "./brandSetupDraft";

/**
 * The platform owner's view of one brand's money: the addon policy (saved with
 * the rest of the brand), the price list (saved per row, live), and the wallet
 * with the payout form. Loads its own data so the brand page stays light.
 */
export function BrandPricingTab({
  brand,
  value,
  onChange,
}: {
  brand: Brand;
  value: Pick<SetupDraft, "addonEditable" | "maxAddonCents">;
  onChange: (patch: Partial<SetupDraft>) => void;
}) {
  const [pricing, setPricing] = useState<BrandPricing | null>(null);
  const [wallet, setWallet] = useState<BrandWallet | null>(null);

  const load = useCallback(async () => {
    const [p, w] = await Promise.all([
      api.super.brands.pricing(brand.id).catch(() => null),
      api.super.brands.wallet(brand.id).catch(() => null),
    ]);
    setPricing(p ?? { rows: [], addonEditable: true, maxAddonCents: null });
    setWallet(w ?? { balances: [], entries: [] });
  }, [brand.id]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="space-y-5">
      <Card className="space-y-4 p-5">
        <div>
          <h3 className="text-base font-semibold">Addon policy</h3>
          <p className="mt-1 text-sm text-muted-foreground">
            Whether the brand's own admin may set addons, and how much they may add. Saved with the
            brand.
          </p>
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="flex items-center justify-between gap-3 rounded-lg border border-border px-3 py-2.5">
            <div>
              <Label htmlFor="b-addon-editable" className="text-sm font-medium">
                Brand admin sets addons
              </Label>
              <p className="text-xs text-muted-foreground">
                Off: only the platform sets this brand's prices.
              </p>
            </div>
            <Switch
              id="b-addon-editable"
              checked={value.addonEditable}
              onCheckedChange={(addonEditable) => onChange({ addonEditable })}
            />
          </div>
          <div>
            <Label htmlFor="b-addon-cap">Addon cap per cycle</Label>
            <div className="mt-1.5 flex items-center gap-2">
              <Input
                id="b-addon-cap"
                type="number"
                min={0}
                step="0.01"
                inputMode="decimal"
                className="max-w-[10rem] tabular-nums"
                value={value.maxAddonCents === null ? "" : (value.maxAddonCents / 100).toFixed(2)}
                placeholder="No cap"
                onChange={(e) => {
                  const raw = e.target.value.trim();
                  onChange({
                    maxAddonCents:
                      raw === "" ? null : Math.round((Number.parseFloat(raw) || 0) * 100),
                  });
                }}
              />
              <span className="text-xs text-muted-foreground">in the plan's currency</span>
            </div>
          </div>
        </div>
      </Card>

      <BrandPricingSection
        pricing={pricing}
        canEdit
        onSave={async (planId, addonCents) => {
          const row = await api.super.brands.setAddon(brand.id, planId, addonCents);
          setPricing((p) =>
            p ? { ...p, rows: p.rows.map((r) => (r.planId === planId ? row : r)) } : p,
          );
          return row;
        }}
        intro="The platform's base price per plan, and this brand's addon on top. The platform owner may set the addon regardless of the policy above."
        onApply={(planId) => api.super.brands.applyPricing(brand.id, planId)}
      />

      <BrandWalletSection
        wallet={wallet}
        onPayout={async (data) => {
          await api.super.brands.payout(brand.id, data);
          await load();
        }}
      />

      <BrandLedgerCard brandId={brand.id} />
    </div>
  );
}
