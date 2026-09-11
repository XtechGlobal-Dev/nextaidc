import * as React from "react";
import { toast } from "sonner";
import { BellOff, Loader2, Plus, Trash2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { api, ApiError } from "@/lib/api";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { CardSkeleton } from "@/components/ui/skeleton";
import { timeAgo } from "@/components/charts/primitives";
import { useApiCenter } from "./ApiCenterContext";
import { SectionHeading } from "./shared";
import type { AlertMetric, AlertRule } from "@/types/apiCenter";

/* ------------------------------------------------------------------ *
 *  Alert rules — the thresholds that raise a flag.
 *
 *  Lives under Settings rather than on its own screen: writing a rule is
 *  configuration, and it belongs beside the quotas and prices those rules
 *  measure against. What the rules *produced* shows up on Overview, where
 *  someone will actually see it.
 * ------------------------------------------------------------------ */

const METRICS: { key: AlertMetric; label: string; unit: string; comparator: "gt" | "lt"; hint: string }[] = [
  { key: "error_rate", label: "Error rate", unit: "%", comparator: "gt", hint: "share of calls that failed" },
  { key: "latency_p95", label: "p95 latency", unit: "ms", comparator: "gt", hint: "95th-percentile response time" },
  { key: "quota_used", label: "Quota used", unit: "%", comparator: "gt", hint: "monthly allowance consumed" },
  { key: "uptime", label: "Uptime", unit: "%", comparator: "lt", hint: "vendor-side availability" },
  { key: "no_traffic", label: "No traffic", unit: "min", comparator: "gt", hint: "minutes since the last call" },
];

export function AlertRulesPanel() {
  const { snapshot } = useApiCenter();
  const [rules, setRules] = React.useState<AlertRule[] | null>(null);
  const [busy, setBusy] = React.useState<string | null>(null);
  const [adding, setAdding] = React.useState(false);
  const [draft, setDraft] = React.useState<{
    provider: string;
    metric: AlertMetric;
    threshold: string;
    severity: "warning" | "critical";
  }>({ provider: "", metric: "error_rate", threshold: "10", severity: "warning" });

  React.useEffect(() => {
    let active = true;
    (async () => {
      try {
        const res = await api.admin.apiCenter.alerts("open");
        if (active) setRules(res.rules);
      } catch (e) {
        if (active) toast.error(e instanceof ApiError ? e.message : "Failed to load alert rules");
      }
    })();
    return () => {
      active = false;
    };
  }, []);

  const toggle = async (rule: AlertRule) => {
    setBusy(rule.id);
    try {
      setRules(await api.admin.apiCenter.updateRule(rule.id, { enabled: !rule.enabled }));
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "Couldn't update the rule");
    } finally {
      setBusy(null);
    }
  };

  const remove = async (rule: AlertRule) => {
    setBusy(rule.id);
    try {
      setRules(await api.admin.apiCenter.deleteRule(rule.id));
      toast.success("Rule deleted");
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "Couldn't delete the rule");
    } finally {
      setBusy(null);
    }
  };

  const add = async (e: React.FormEvent) => {
    e.preventDefault();
    const threshold = Number(draft.threshold);
    if (!Number.isFinite(threshold) || threshold < 0) {
      toast.error("Enter a valid threshold");
      return;
    }
    const metric = METRICS.find((m) => m.key === draft.metric)!;
    setBusy("new");
    try {
      setRules(
        await api.admin.apiCenter.createRule({
          provider: draft.provider || null,
          metric: draft.metric,
          comparator: metric.comparator,
          threshold,
          severity: draft.severity,
        }),
      );
      setAdding(false);
      toast.success("Alert rule created");
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Couldn't create the rule");
    } finally {
      setBusy(null);
    }
  };

  if (!rules) return <CardSkeleton rows={6} />;

  const providers = snapshot?.providers.filter((p) => p.wired) ?? [];
  const selectedMetric = METRICS.find((m) => m.key === draft.metric);
  const allOff = rules.length > 0 && rules.every((r) => !r.enabled);

  return (
    <div className="space-y-4">
      <SectionHeading
        title="Alert rules"
        hint="A rule with no provider watches every connected integration, including ones added later"
        actions={
          <Button variant={adding ? "ghost" : "outline"} size="sm" onClick={() => setAdding((a) => !a)}>
            {adding ? (
              "Cancel"
            ) : (
              <>
                <Plus className="size-4" /> New rule
              </>
            )}
          </Button>
        }
      />

      {adding && (
        <Card className="p-4">
          <form onSubmit={add} className="flex flex-wrap items-end gap-3">
            <label className="flex flex-col gap-1 text-xs">
              <span className="font-medium text-muted-foreground">Provider</span>
              <select
                value={draft.provider}
                onChange={(e) => setDraft((d) => ({ ...d, provider: e.target.value }))}
                className="h-9 rounded-lg border border-border bg-card px-2.5 text-sm"
              >
                <option value="">All providers</option>
                {providers.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex flex-col gap-1 text-xs">
              <span className="font-medium text-muted-foreground">Metric</span>
              <select
                value={draft.metric}
                onChange={(e) => setDraft((d) => ({ ...d, metric: e.target.value as AlertMetric }))}
                className="h-9 rounded-lg border border-border bg-card px-2.5 text-sm"
              >
                {METRICS.map((m) => (
                  <option key={m.key} value={m.key}>
                    {m.label} — {m.hint}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex flex-col gap-1 text-xs">
              <span className="font-medium text-muted-foreground">
                {selectedMetric?.comparator === "lt" ? "Falls below" : "Rises above"}
              </span>
              <div className="flex items-center gap-1.5">
                <input
                  type="number"
                  min={0}
                  step="any"
                  value={draft.threshold}
                  onChange={(e) => setDraft((d) => ({ ...d, threshold: e.target.value }))}
                  className="h-9 w-24 rounded-lg border border-border bg-card px-2.5 text-sm tabular-nums"
                />
                <span className="text-xs text-muted-foreground">{selectedMetric?.unit}</span>
              </div>
            </label>
            <label className="flex flex-col gap-1 text-xs">
              <span className="font-medium text-muted-foreground">Severity</span>
              <select
                value={draft.severity}
                onChange={(e) => setDraft((d) => ({ ...d, severity: e.target.value as "warning" | "critical" }))}
                className="h-9 rounded-lg border border-border bg-card px-2.5 text-sm"
              >
                <option value="warning">Warning</option>
                <option value="critical">Critical</option>
              </select>
            </label>
            <Button type="submit" size="sm" disabled={busy === "new"}>
              {busy === "new" ? <Loader2 className="size-4 animate-spin" /> : <Plus className="size-4" />}
              Create
            </Button>
          </form>
        </Card>
      )}

      <Card className="overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[40rem] text-sm">
            <thead>
              <tr className="border-b border-border text-left text-[11px] uppercase tracking-wide text-muted-foreground">
                <th className="px-5 py-2 font-medium">Scope</th>
                <th className="px-3 py-2 font-medium">Condition</th>
                <th className="px-3 py-2 font-medium">Severity</th>
                <th className="px-3 py-2 text-right font-medium">Last fired</th>
                <th className="px-3 py-2 text-center font-medium">On</th>
                <th className="px-5 py-2" />
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {rules.map((r) => (
                <tr key={r.id} className={cn("transition-colors", !r.enabled && "opacity-55")}>
                  <td className="px-5 py-2.5 font-medium">{r.providerName ?? "All providers"}</td>
                  <td className="px-3 py-2.5 text-muted-foreground">
                    {r.metricLabel} {r.comparator === "lt" ? "<" : ">"}{" "}
                    <span className="font-semibold tabular-nums text-foreground">
                      {r.threshold}
                      {r.unit}
                    </span>
                  </td>
                  <td className="px-3 py-2.5">
                    <Badge variant={r.severity === "critical" ? "danger" : "warning"} className="uppercase tracking-wide">
                      {r.severity}
                    </Badge>
                  </td>
                  <td className="px-3 py-2.5 text-right text-[11px] text-muted-foreground">
                    {r.lastFiredAt ? timeAgo(r.lastFiredAt) : "Never"}
                  </td>
                  <td className="px-3 py-2.5 text-center">
                    <Switch
                      checked={r.enabled}
                      onCheckedChange={() => toggle(r)}
                      disabled={busy === r.id}
                      aria-label={`${r.enabled ? "Disable" : "Enable"} rule`}
                    />
                  </td>
                  <td className="px-5 py-2.5 text-right">
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => remove(r)}
                      disabled={busy === r.id}
                      aria-label="Delete rule"
                      className="text-muted-foreground hover:text-danger"
                    >
                      <Trash2 className="size-4" />
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      {allOff && (
        <p className="flex items-center gap-1.5 text-xs text-warning">
          <BellOff className="size-3.5" />
          Every rule is disabled — nothing is watching these integrations right now.
        </p>
      )}
    </div>
  );
}
