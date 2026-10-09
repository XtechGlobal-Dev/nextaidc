import { useCallback, useEffect, useState } from "react";
import { Check, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { api, ApiError, type Brand, type BrandPricing, type BrandWallet } from "@/lib/api";
import { BrandPricingSection } from "./BrandPricingSection";
import { BrandWalletSection } from "./BrandWalletSection";

/** Platform owner's view of a brand's money: the add-on policy, the price list (saved per row) and the wallet with
 *  its payouts. Loads and saves its own data. */
export function BrandPricingTab({ brand }: { brand: Brand }) {
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
      {pricing && (
        <AddonPolicyCard
          brandId={brand.id}
          addonEditable={pricing.addonEditable}
          maxAddonCents={pricing.maxAddonCents}
          onSaved={(policy) => setPricing((p) => (p ? { ...p, ...policy } : p))}
        />
      )}

      <BrandPricingSection
        pricing={pricing}
        canEdit
        onSave={async (planId, addonCents) => {
          const row = await api.super.brands.setAddon(brand.id, planId, addonCents);
          setPricing((p) => (p ? { ...p, rows: p.rows.map((r) => (r.planId === planId ? row : r)) } : p));
          return row;
        }}
        intro="The platform's base price per plan, and this brand's add-on on top. You may set the add-on regardless of the policy above."
      />

      <BrandWalletSection
        wallet={wallet}
        onPayout={async (data) => {
          await api.super.brands.payout(brand.id, data);
          await load();
        }}
      />
    </div>
  );
}

function AddonPolicyCard({
  brandId,
  addonEditable,
  maxAddonCents,
  onSaved,
}: {
  brandId: string;
  addonEditable: boolean;
  maxAddonCents: number | null;
  onSaved: (policy: { addonEditable: boolean; maxAddonCents: number | null }) => void;
}) {
  const capText = (cents: number | null) => (cents === null ? "" : (cents / 100).toFixed(2));
  const [editable, setEditable] = useState(addonEditable);
  const [cap, setCap] = useState(capText(maxAddonCents));
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setEditable(addonEditable);
    setCap(capText(maxAddonCents));
  }, [addonEditable, maxAddonCents]);

  const capCents = cap.trim() === "" ? null : Math.round((Number.parseFloat(cap) || 0) * 100);
  const dirty = editable !== addonEditable || capCents !== maxAddonCents;

  async function save() {
    setSaving(true);
    try {
      onSaved(await api.super.brands.setPricingPolicy(brandId, { addonEditable: editable, maxAddonCents: capCents }));
      toast.success("Add-on policy saved");
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "Couldn't save the policy.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card className="space-y-4 p-5">
      <div>
        <h3 className="text-base font-semibold">Add-on policy</h3>
        <p className="mt-1 text-sm text-muted-foreground">
          Whether the brand's own admin may set add-ons, and how much they may add per billing cycle.
        </p>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="flex items-center justify-between gap-3 rounded-lg border border-border px-3 py-2.5">
          <div>
            <Label htmlFor="b-addon-editable" className="text-sm font-medium">
              Brand admin sets add-ons
            </Label>
            <p className="text-xs text-muted-foreground">Off: only the platform sets this brand's prices.</p>
          </div>
          <Switch id="b-addon-editable" checked={editable} onCheckedChange={setEditable} />
        </div>
        <div>
          <Label htmlFor="b-addon-cap">Add-on cap per cycle</Label>
          <div className="mt-2 flex items-center gap-2">
            <Input
              id="b-addon-cap"
              type="number"
              min={0}
              step="0.01"
              inputMode="decimal"
              className="max-w-[10rem] tabular-nums"
              value={cap}
              placeholder="No cap"
              onChange={(e) => setCap(e.target.value)}
            />
            <span className="text-xs text-muted-foreground">in the plan's currency</span>
          </div>
        </div>
      </div>
      <div className="flex justify-end">
        <Button size="sm" onClick={() => void save()} disabled={!dirty || saving || (capCents !== null && capCents < 0)}>
          {saving ? <Loader2 className="size-4 animate-spin" /> : <Check className="size-4" />}
          Save policy
        </Button>
      </div>
    </Card>
  );
}
