import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { api, ApiError, type BrandAddon, type BrandModuleId } from "@/lib/api";
import { MoneyInput } from "../brands/BrandBillingFields";

// The add-on list: what each module costs a brand whose plan doesn't include it. A module that's off here
// isn't sold at all — brands whose plan leaves it out simply don't get it.

type Row = { moduleId: BrandModuleId; label: string; description: string; priceCents: number; active: boolean };

export function BrandAddonsDialog({
  open,
  onOpenChange,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved: (addons: BrandAddon[]) => void;
}) {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    let active = true;
    setRows(null);
    api.super.brandAddons
      .list()
      .then(
        (list) =>
          active &&
          setRows(list.map((a) => ({ ...a, priceCents: a.priceCents ?? 0, active: a.active }))),
      )
      .catch((e) => {
        toast.error(e instanceof ApiError ? e.message : "Couldn't load the add-ons");
        if (active) onOpenChange(false);
      });
    return () => {
      active = false;
    };
  }, [open, onOpenChange]);

  const set = (id: BrandModuleId, patch: Partial<Row>) =>
    setRows((rs) => rs?.map((r) => (r.moduleId === id ? { ...r, ...patch } : r)) ?? rs);

  const problem = rows?.find((r) => r.active && r.priceCents <= 0);

  async function save() {
    if (!rows) return;
    setSaving(true);
    try {
      const saved = await api.super.brandAddons.save(
        rows.map((r) => ({ moduleId: r.moduleId, priceCents: r.priceCents, active: r.active })),
      );
      toast.success("Add-ons saved — brands on a plan see the new prices from their next invoice.");
      onSaved(saved);
      onOpenChange(false);
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "Couldn't save the add-ons");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !saving && onOpenChange(o)}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Add-ons</DialogTitle>
          <DialogDescription>
            What a brand pays each month for a feature its plan doesn&rsquo;t include — charged in the brand&rsquo;s
            plan currency. Switched off, the feature isn&rsquo;t sold at all. SMS to Caller and WhatsApp don&rsquo;t
            appear here — they&rsquo;re default features, included free whenever a plan switches them on.
          </DialogDescription>
        </DialogHeader>

        {rows === null ? (
          <div className="flex justify-center py-10 text-muted-foreground">
            <Loader2 className="size-5 animate-spin" />
          </div>
        ) : (
          <div className="divide-y divide-border rounded-xl border border-border">
            {rows.map((r) => (
              <div key={r.moduleId} className="flex flex-wrap items-center gap-3 px-3.5 py-3">
                <div className="min-w-0 flex-1 basis-40">
                  <p className="text-sm font-medium">{r.label}</p>
                  <p className="text-xs text-muted-foreground">{r.description}</p>
                </div>
                <div className="flex items-center gap-1.5">
                  <MoneyInput
                    id={`addon-${r.moduleId}`}
                    cents={r.priceCents}
                    onChange={(priceCents) => set(r.moduleId, { priceCents })}
                    placeholder="15.00"
                    className="h-9 w-24"
                    aria-label={`${r.label} monthly price`}
                  />
                  <span className="text-xs text-muted-foreground">/mo</span>
                </div>
                <label className="flex items-center gap-2 text-xs text-muted-foreground">
                  <Switch
                    checked={r.active}
                    onCheckedChange={(active) => set(r.moduleId, { active })}
                    aria-label={`Offer ${r.label} as an add-on`}
                  />
                  Offered
                </label>
              </div>
            ))}
          </div>
        )}

        {problem && <p className="text-xs text-danger">Give {problem.label} a price, or switch it off.</p>}
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
            Cancel
          </Button>
          <Button type="button" onClick={() => void save()} disabled={!rows || !!problem || saving}>
            {saving && <Loader2 className="size-4 animate-spin" />}
            Save add-ons
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
