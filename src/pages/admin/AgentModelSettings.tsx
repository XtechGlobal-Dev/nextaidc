import { useEffect, useMemo, useState } from "react";
import { Loader2, Save, Cpu, RotateCcw, RefreshCw } from "lucide-react";
import { toast } from "sonner";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { api, ApiError, type AgentLlmOption } from "@/lib/api";

/**
 * Admin editor for the platform-wide default LLM that powers every provisioned
 * voice assistant. When a new customer's agent is created (or an existing one is
 * synced), Vapi is told to use the provider + model chosen here — replacing the
 * built-in default. Owners never see this; it's a platform-level default.
 */
export function AgentModelSettings() {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [options, setOptions] = useState<AgentLlmOption[]>([]);
  const [defaultLlm, setDefaultLlm] = useState<{ provider: string; model: string } | null>(null);
  // The currently-saved selection (server truth) + the in-progress draft.
  const [saved, setSaved] = useState<{ provider: string; model: string } | null>(null);
  const [provider, setProvider] = useState("");
  const [model, setModel] = useState("");

  useEffect(() => {
    let active = true;
    api.admin.agentLlm
      .get()
      .then((r) => {
        if (!active) return;
        setOptions(r.options);
        setDefaultLlm(r.default);
        setSaved({ provider: r.provider, model: r.model });
        setProvider(r.provider);
        setModel(r.model);
      })
      .catch((e) => toast.error(e instanceof ApiError ? e.message : "Failed to load agent model"))
      .finally(() => active && setLoading(false));
    return () => {
      active = false;
    };
  }, []);

  // Force the server to re-pull Vapi's live catalogue (bypasses its cache). Keeps
  // the current selection; only the available provider/model list is refreshed.
  async function refresh() {
    setRefreshing(true);
    try {
      const r = await api.admin.agentLlm.get(true);
      setOptions(r.options);
      setDefaultLlm(r.default);
      toast.success("Model list refreshed from Vapi");
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "Failed to refresh from Vapi");
    } finally {
      setRefreshing(false);
    }
  }

  // Providers in catalogue order, de-duped, each with its human label.
  const providers = useMemo(() => {
    const seen = new Map<string, string>();
    for (const o of options) if (!seen.has(o.provider)) seen.set(o.provider, o.providerLabel);
    return [...seen].map(([value, label]) => ({ value, label }));
  }, [options]);

  // Models available under the picked provider.
  const providerModels = useMemo(
    () => options.filter((o) => o.provider === provider),
    [options, provider],
  );

  // The currently-selected option (for showing its cost/latency below the picker).
  const selectedOption = useMemo(
    () => options.find((o) => o.provider === provider && o.model === model) ?? null,
    [options, provider, model],
  );

  // Vapi-style "800ms · $0.01" meta line; omits either part Vapi can't estimate.
  const metaText = (o: AgentLlmOption): string => {
    const parts: string[] = [];
    if (o.latencyMs != null) parts.push(`${o.latencyMs}ms`);
    if (o.costPerMin != null) parts.push(`$${o.costPerMin.toFixed(2)}/min`);
    return parts.join(" · ");
  };

  const isDefault =
    !!defaultLlm && saved?.provider === defaultLlm.provider && saved?.model === defaultLlm.model;
  const dirty = !!saved && (saved.provider !== provider || saved.model !== model);

  function onProviderChange(next: string) {
    setProvider(next);
    // Keep the model valid: if the current model isn't offered by the new
    // provider, snap to that provider's first model.
    const stillValid = options.some((o) => o.provider === next && o.model === model);
    if (!stillValid) {
      const first = options.find((o) => o.provider === next);
      if (first) setModel(first.model);
    }
  }

  async function save(p: string, m: string) {
    setSaving(true);
    try {
      const r = await api.admin.agentLlm.set(p, m);
      setSaved({ provider: r.provider, model: r.model });
      setProvider(r.provider);
      setModel(r.model);
      toast.success("Default agent model saved", {
        description: "New agents use it immediately; existing ones update on their next AI-Brain sync.",
      });
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "Failed to save model");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card className="overflow-hidden">
      <div className="flex flex-col items-start gap-2.5 border-b border-border bg-card px-4 py-4 sm:flex-row sm:items-start sm:justify-between sm:gap-3 sm:px-6 sm:py-5">
        <div className="flex flex-col items-start gap-2.5 sm:flex-row sm:items-center sm:gap-3.5">
          <span className="grid size-12 shrink-0 aspect-square place-items-center rounded-2xl bg-primary/15 text-primary shadow-[inset_0_0_0_1px_hsl(217_84%_55%/0.25)]">
            <Cpu className="size-6" />
          </span>
          <div>
            <p className="text-lg font-semibold leading-tight tracking-tight">Default Agent Model</p>
            <p className="mt-0.5 text-xs text-muted-foreground">
              The LLM every new assistant is created with.
            </p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {!loading &&
            (isDefault ? <Badge variant="outline">Using default</Badge> : <Badge variant="primary">Custom</Badge>)}
          <Button
            variant="outline"
            size="sm"
            onClick={refresh}
            disabled={loading || refreshing}
            title="Re-pull the latest provider & model list from Vapi"
          >
            <RefreshCw className={`size-4 ${refreshing ? "animate-spin" : ""}`} />
            Refresh from Vapi
          </Button>
        </div>
      </div>

      <div className="space-y-4 p-4 sm:p-6">
        <p className="text-sm text-muted-foreground">
          Pick the provider and model that power every customer's voice assistant. The provider and
          model list is synced live from Vapi. Your choice is applied when a new agent is created and
          re-applied whenever an existing agent is synced — so changing it rolls out to everyone on
          their next AI-Brain save.
        </p>

        {loading ? (
          <div className="flex h-24 items-center justify-center text-muted-foreground">
            <Loader2 className="size-5 animate-spin" />
          </div>
        ) : (
          <>
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label className="text-xs text-muted-foreground">Provider</Label>
                <Select value={provider} onValueChange={onProviderChange}>
                  <SelectTrigger>
                    <SelectValue placeholder="Select provider" />
                  </SelectTrigger>
                  <SelectContent>
                    {providers.map((p) => (
                      <SelectItem key={p.value} value={p.value}>
                        {p.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs text-muted-foreground">Model</Label>
                <Select value={model} onValueChange={setModel}>
                  <SelectTrigger>
                    <SelectValue placeholder="Select model" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      <SelectLabel>{providers.find((p) => p.value === provider)?.label ?? "Models"}</SelectLabel>
                      {providerModels.map((o) => (
                        <SelectItem key={o.model} value={o.model}>
                          <span className="flex w-full items-center justify-between gap-6">
                            <span>{o.label}</span>
                            {metaText(o) && (
                              <span className="shrink-0 font-mono text-xs text-muted-foreground">
                                {metaText(o)}
                              </span>
                            )}
                          </span>
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="font-mono text-xs text-muted-foreground">
                {provider} · {model}
                {selectedOption && metaText(selectedOption) && ` — ${metaText(selectedOption)}`}
              </span>
              <div className="flex flex-wrap gap-2">
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-danger hover:bg-danger-tint hover:text-danger"
                  onClick={() => defaultLlm && save(defaultLlm.provider, defaultLlm.model)}
                  disabled={saving || isDefault}
                  title="Revert to the built-in default model"
                >
                  <RotateCcw className="size-4" /> Reset to default
                </Button>
                <Button size="sm" onClick={() => save(provider, model)} disabled={saving || !dirty}>
                  {saving ? <Loader2 className="size-4 animate-spin" /> : <Save className="size-4" />}
                  Save
                </Button>
              </div>
            </div>
          </>
        )}
      </div>
    </Card>
  );
}
