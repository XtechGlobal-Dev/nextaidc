import * as React from "react";
import { toast } from "sonner";
import { Bell, BellOff, Info, Loader2, Save, Settings2, SlidersHorizontal } from "lucide-react";
import { cn } from "@/lib/utils";
import { api, ApiError } from "@/lib/api";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { CardSkeleton } from "@/components/ui/skeleton";
import { useApiCenter } from "@/components/admin/api-center/ApiCenterContext";
import { AlertRulesPanel } from "@/components/admin/api-center/AlertRulesPanel";
import { ApiCenterEmpty, SectionHeading, Segmented } from "@/components/admin/api-center/shared";
import type { ProviderSettingRow } from "@/types/apiCenter";

/* ------------------------------------------------------------------ *
 *  Settings — the per-provider knobs the rest of the API Center reads,
 *  plus the alert rules that measure against them.
 *
 *  Nothing here is required: a provider with no row uses the defaults shipped in
 *  the code, which is why adding a vendor never needs a seed step. Filling a row
 *  in is how an operator teaches this dashboard what "too much" means for that
 *  particular vendor — and the alert rules beside it are what act on that.
 *
 *  Rows save individually rather than behind one page-level Save, so a mistake
 *  in one provider can't discard edits to another.
 * ------------------------------------------------------------------ */

type Tab = "providers" | "alerts";

const TABS: { key: Tab; label: string; icon: typeof Bell }[] = [
  { key: "providers", label: "Providers", icon: SlidersHorizontal },
  { key: "alerts", label: "Alert rules", icon: Bell },
];

type Draft = {
  monthlyQuota: string;
  unitCostUsd: string;
  rateLimitPerMin: string;
  environment: "production" | "sandbox";
  keyExpiresAt: string;
  muted: boolean;
};

function toDraft(row: ProviderSettingRow): Draft {
  return {
    monthlyQuota: row.monthlyQuota > 0 ? String(row.monthlyQuota) : "",
    unitCostUsd: row.unitCostUsd != null ? String(row.unitCostUsd) : "",
    rateLimitPerMin: row.rateLimitPerMin > 0 ? String(row.rateLimitPerMin) : "",
    environment: row.environment === "sandbox" ? "sandbox" : "production",
    // <input type="date"> wants YYYY-MM-DD, not an ISO instant.
    keyExpiresAt: row.keyExpiresAt ? row.keyExpiresAt.slice(0, 10) : "",
    muted: row.muted,
  };
}

const inputClass =
  "h-9 w-full rounded-lg border border-border bg-card px-2.5 text-sm tabular-nums focus-visible:focus-ring";

export default function ApiCenterSettingsPage() {
  const { filters, refresh } = useApiCenter();
  const [tab, setTab] = React.useState<Tab>("providers");
  const [rows, setRows] = React.useState<ProviderSettingRow[] | null>(null);
  const [drafts, setDrafts] = React.useState<Record<string, Draft>>({});
  const [loading, setLoading] = React.useState(true);
  const [saving, setSaving] = React.useState<string | null>(null);

  React.useEffect(() => {
    let active = true;
    (async () => {
      try {
        const res = await api.admin.apiCenter.settings();
        if (!active) return;
        setRows(res);
        setDrafts(Object.fromEntries(res.map((r) => [r.provider, toDraft(r)])));
      } catch (e) {
        if (active) toast.error(e instanceof ApiError ? e.message : "Failed to load provider settings");
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => {
      active = false;
    };
  }, []);

  const patch = (provider: string, part: Partial<Draft>) =>
    setDrafts((d) => ({ ...d, [provider]: { ...d[provider], ...part } }));

  const save = async (row: ProviderSettingRow) => {
    const draft = drafts[row.provider];
    if (!draft) return;
    setSaving(row.provider);
    try {
      const saved = await api.admin.apiCenter.saveSettings(row.provider, {
        monthlyQuota: draft.monthlyQuota.trim() === "" ? 0 : Number(draft.monthlyQuota),
        // Empty means "fall back to the code default", which is a null override,
        // not a price of zero.
        unitCostUsd: draft.unitCostUsd.trim() === "" ? null : Number(draft.unitCostUsd),
        rateLimitPerMin: draft.rateLimitPerMin.trim() === "" ? 0 : Number(draft.rateLimitPerMin),
        environment: draft.environment,
        keyExpiresAt: draft.keyExpiresAt ? new Date(`${draft.keyExpiresAt}T00:00:00.000Z`).toISOString() : null,
        muted: draft.muted,
      });
      // The endpoint returns the same shape GET /settings does, so the saved row
      // replaces the old one outright — no field-by-field merging to drift.
      setRows((rs) => (rs ?? []).map((r) => (r.provider === row.provider ? saved : r)));
      setDrafts((d) => ({ ...d, [row.provider]: toDraft(saved) }));
      toast.success(`${row.name} settings saved`);
      // The snapshot's quota, cost and mute state all derive from this row.
      void refresh();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "Couldn't save these settings");
    } finally {
      setSaving(null);
    }
  };

  // The switcher renders before the providers fetch resolves, so alert rules are
  // reachable even while the settings table is still loading.
  const switcher = <Segmented value={tab} onChange={setTab} options={TABS} label="Settings view" />;

  if (tab === "alerts") {
    return (
      <div className="space-y-4">
        {switcher}
        <AlertRulesPanel />
      </div>
    );
  }

  if (loading) {
    return (
      <div className="space-y-4">
        {switcher}
        <CardSkeleton rows={8} />
      </div>
    );
  }
  if (!rows) return null;

  const needle = filters.search.trim().toLowerCase();
  const visible = rows.filter((r) => {
    if (filters.category !== "all" && r.category !== filters.category) return false;
    if (needle && !r.name.toLowerCase().includes(needle) && !r.provider.toLowerCase().includes(needle)) return false;
    return true;
  });

  const dirty = (row: ProviderSettingRow) => {
    const a = drafts[row.provider];
    const b = toDraft(row);
    return !!a && JSON.stringify(a) !== JSON.stringify(b);
  };

  return (
    <div className="space-y-4">
      {switcher}

      <div className="flex items-start gap-2 rounded-lg border border-border bg-warm p-3 text-xs text-muted-foreground">
        <Info className="mt-px size-4 shrink-0 text-primary" />
        <p>
          These values teach the dashboard what "too much" means per vendor. Leave a field blank to use the default
          shipped in code. <strong className="font-semibold text-foreground">Muting</strong> stops a provider raising
          alerts but does not change its reported health — a muted provider still shows red when it is red.
        </p>
      </div>

      {visible.length === 0 ? (
        <ApiCenterEmpty
          icon={Settings2}
          title="No providers match these filters"
          message="Adjust the category filter or clear the search above."
        />
      ) : (
        <Card className="overflow-hidden">
          <SectionHeading
            title="Per-provider configuration"
            className="p-5 pb-0"
            hint="Each row saves on its own"
          />
          <div className="overflow-x-auto">
            <table className="w-full min-w-[64rem] text-sm">
              <thead>
                <tr className="border-b border-border text-left text-[11px] uppercase tracking-wide text-muted-foreground">
                  <th className="px-5 py-2 font-medium">Provider</th>
                  <th className="px-3 py-2 font-medium">Monthly quota</th>
                  <th className="px-3 py-2 font-medium">Unit price (USD)</th>
                  <th className="px-3 py-2 font-medium">Rate limit /min</th>
                  <th className="px-3 py-2 font-medium">Environment</th>
                  <th className="px-3 py-2 font-medium">Key expires</th>
                  <th className="px-3 py-2 text-center font-medium">Mute alerts</th>
                  <th className="px-5 py-2" />
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {visible.map((row) => {
                  const d = drafts[row.provider];
                  if (!d) return null;
                  const isDirty = dirty(row);
                  return (
                    <tr key={row.provider} className={cn("align-top", d.muted && "opacity-70")}>
                      <td className="px-5 py-3">
                        <p className="font-medium">{row.name}</p>
                        <p className="text-[11px] text-muted-foreground">{row.unit.replace(/_/g, " ")}</p>
                        {row.costConfidence === "metered" && (
                          <Badge variant="success" className="mt-1">
                            Metered
                          </Badge>
                        )}
                      </td>
                      <td className="px-3 py-3">
                        <input
                          type="number"
                          min={0}
                          inputMode="numeric"
                          value={d.monthlyQuota}
                          onChange={(e) => patch(row.provider, { monthlyQuota: e.target.value })}
                          placeholder="Not set"
                          aria-label={`${row.name} monthly quota`}
                          className={cn(inputClass, "w-32")}
                        />
                      </td>
                      <td className="px-3 py-3">
                        <input
                          type="number"
                          min={0}
                          step="any"
                          value={d.unitCostUsd}
                          onChange={(e) => patch(row.provider, { unitCostUsd: e.target.value })}
                          placeholder="Default"
                          aria-label={`${row.name} unit price`}
                          className={cn(inputClass, "w-28")}
                        />
                        {!row.unitCostOverridden && row.unitCostUsd != null && (
                          <p className="mt-0.5 text-[10px] text-muted-foreground">code default</p>
                        )}
                      </td>
                      <td className="px-3 py-3">
                        <input
                          type="number"
                          min={0}
                          value={d.rateLimitPerMin}
                          onChange={(e) => patch(row.provider, { rateLimitPerMin: e.target.value })}
                          placeholder="Unknown"
                          aria-label={`${row.name} rate limit`}
                          className={cn(inputClass, "w-28")}
                        />
                      </td>
                      <td className="px-3 py-3">
                        <select
                          value={d.environment}
                          onChange={(e) =>
                            patch(row.provider, { environment: e.target.value as "production" | "sandbox" })
                          }
                          aria-label={`${row.name} environment`}
                          className={cn(inputClass, "w-32")}
                        >
                          <option value="production">Production</option>
                          <option value="sandbox">Sandbox</option>
                        </select>
                      </td>
                      <td className="px-3 py-3">
                        <input
                          type="date"
                          value={d.keyExpiresAt}
                          onChange={(e) => patch(row.provider, { keyExpiresAt: e.target.value })}
                          aria-label={`${row.name} key expiry`}
                          className={cn(inputClass, "w-40")}
                        />
                      </td>
                      <td className="px-3 py-3 text-center">
                        <Switch
                          checked={d.muted}
                          onCheckedChange={(v) => patch(row.provider, { muted: v })}
                          aria-label={`Mute ${row.name} alerts`}
                        />
                        {d.muted && <BellOff className="mx-auto mt-1 size-3 text-muted-foreground" />}
                      </td>
                      <td className="px-5 py-3 text-right">
                        <Button
                          size="sm"
                          variant={isDirty ? "primary" : "outline"}
                          disabled={!isDirty || saving === row.provider}
                          onClick={() => save(row)}
                        >
                          {saving === row.provider ? (
                            <Loader2 className="size-4 animate-spin" />
                          ) : (
                            <Save className="size-4" />
                          )}
                          Save
                        </Button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </Card>
      )}
    </div>
  );
}
