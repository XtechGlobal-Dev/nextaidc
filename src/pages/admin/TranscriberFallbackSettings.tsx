import { useEffect, useMemo, useState } from "react";
import { Loader2, Save, Waves, RefreshCw, ShieldCheck } from "lucide-react";
import { toast } from "sonner";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { api, ApiError, type TranscriberOption } from "@/lib/api";

const NONE = "__none__"; // Select needs a non-empty value for the "no preferred fallback" option.

/**
 * Admin editor for the platform-wide transcriber (speech-to-text) FALLBACK. The
 * primary transcriber is still auto-chosen by the agent's language; here the admin
 * sets what Vapi should try if that primary STT fails: an optional preferred
 * provider/model (tried first), plus an Auto Fallback toggle (we then also
 * auto-pick a capable backup). Only backups that can hear an agent's language are
 * ever applied. Rolls out to a customer's live agent on their next AI-Brain sync.
 */
export function TranscriberFallbackSettings() {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [options, setOptions] = useState<TranscriberOption[]>([]);
  // Saved server truth + in-progress draft.
  const [saved, setSaved] = useState<{ autoFallback: boolean; provider: string; model: string } | null>(null);
  const [autoFallback, setAutoFallback] = useState(false);
  const [provider, setProvider] = useState("");
  const [model, setModel] = useState("");

  useEffect(() => {
    let active = true;
    api.admin.transcriberFallback
      .get()
      .then((r) => {
        if (!active) return;
        setOptions(r.options);
        setSaved({ autoFallback: r.autoFallback, provider: r.provider, model: r.model });
        setAutoFallback(r.autoFallback);
        setProvider(r.provider);
        setModel(r.model);
      })
      .catch((e) => toast.error(e instanceof ApiError ? e.message : "Failed to load transcriber fallback"))
      .finally(() => active && setLoading(false));
    return () => {
      active = false;
    };
  }, []);

  async function refresh() {
    setRefreshing(true);
    try {
      const r = await api.admin.transcriberFallback.get(true);
      setOptions(r.options);
      toast.success("Transcriber list refreshed from Vapi");
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "Failed to refresh from Vapi");
    } finally {
      setRefreshing(false);
    }
  }

  const selected = useMemo(() => options.find((o) => o.provider === provider) ?? null, [options, provider]);

  function onProviderChange(next: string) {
    if (next === NONE) {
      setProvider("");
      setModel("");
      return;
    }
    setProvider(next);
    // Snap the model to the new provider's first (or clear it when it takes none).
    const opt = options.find((o) => o.provider === next);
    setModel(opt?.models[0] ?? "");
  }

  const dirty =
    !!saved &&
    (saved.autoFallback !== autoFallback || saved.provider !== provider || saved.model !== model);
  const configured = autoFallback || !!provider;

  async function save() {
    setSaving(true);
    try {
      const r = await api.admin.transcriberFallback.set({ autoFallback, provider, model });
      setSaved({ autoFallback: r.autoFallback, provider: r.provider, model: r.model });
      setAutoFallback(r.autoFallback);
      setProvider(r.provider);
      setModel(r.model);
      toast.success("Transcriber fallback saved", {
        description: "New agents use it immediately; existing ones update on their next AI-Brain sync.",
      });
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "Failed to save transcriber fallback");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card className="overflow-hidden">
      <div className="flex flex-col items-start gap-2.5 border-b border-border bg-card px-4 py-4 sm:flex-row sm:items-start sm:justify-between sm:gap-3 sm:px-6 sm:py-5">
        <div className="flex flex-col items-start gap-2.5 sm:flex-row sm:items-center sm:gap-3.5">
          <span className="grid size-12 shrink-0 aspect-square place-items-center rounded-2xl bg-primary/15 text-primary shadow-[inset_0_0_0_1px_hsl(217_84%_55%/0.25)]">
            <Waves className="size-6" />
          </span>
          <div>
            <p className="text-lg font-semibold leading-tight tracking-tight">Transcriber Fallback</p>
            <p className="mt-0.5 text-xs text-muted-foreground">
              Backup speech-to-text if the primary fails on a call.
            </p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {!loading &&
            (configured ? <Badge variant="primary">On</Badge> : <Badge variant="outline">Off</Badge>)}
          <Button
            variant="outline"
            size="sm"
            onClick={refresh}
            disabled={loading || refreshing}
            title="Re-pull the latest transcriber list from Vapi"
          >
            <RefreshCw className={`size-4 ${refreshing ? "animate-spin" : ""}`} />
            Refresh from Vapi
          </Button>
        </div>
      </div>

      <div className="space-y-5 p-4 sm:p-6">
        <p className="text-sm text-muted-foreground">
          The primary transcriber is chosen automatically for each agent from its language. This
          fallback is what Vapi switches to if that primary fails mid-call — so calls keep working.
          It rolls out to every agent on their next AI-Brain sync.
        </p>

        {loading ? (
          <div className="flex h-24 items-center justify-center text-muted-foreground">
            <Loader2 className="size-5 animate-spin" />
          </div>
        ) : (
          <>
            {/* Preferred manual fallback — tried FIRST when set. */}
            <div className="space-y-3 rounded-xl border border-border bg-warm p-4">
              <div>
                <p className="text-sm font-semibold text-foreground">Preferred fallback</p>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  Optional. Tried first if the primary fails. Its language is matched to each agent
                  automatically — and it's skipped for an agent it can't transcribe.
                </p>
              </div>
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <Label className="text-xs text-muted-foreground">Provider</Label>
                  <Select value={provider || NONE} onValueChange={onProviderChange}>
                    <SelectTrigger>
                      <SelectValue placeholder="None" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={NONE}>None</SelectItem>
                      {options.map((o) => (
                        <SelectItem key={o.provider} value={o.provider}>
                          {o.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs text-muted-foreground">Model</Label>
                  <Select
                    value={model}
                    onValueChange={setModel}
                    disabled={!provider || !selected?.models.length}
                  >
                    <SelectTrigger>
                      <SelectValue placeholder={selected && !selected.models.length ? "No model needed" : "Select model"} />
                    </SelectTrigger>
                    <SelectContent>
                      {(selected?.models ?? []).map((m) => (
                        <SelectItem key={m} value={m}>
                          {m}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>
            </div>

            {/* Auto fallback — after the preferred one (if any). */}
            <div className="flex items-start justify-between gap-4 rounded-xl border border-border bg-card p-4">
              <div className="min-w-0">
                <p className="text-sm font-semibold text-foreground">Auto fallback</p>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  Also let us auto-pick a capable backup STT (after your preferred one, if set). A
                  good safety net when you don't want to choose a specific provider.
                </p>
              </div>
              <Switch
                checked={autoFallback}
                onCheckedChange={setAutoFallback}
                disabled={saving}
                aria-label="Enable auto fallback"
              />
            </div>

            <div className="flex items-center gap-2 rounded-lg border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
              <ShieldCheck className="size-4 shrink-0 text-success" />
              A fallback is only applied when it can actually transcribe the agent's language — a
              backup that can't hear the caller is skipped, never used.
            </div>

            <div className="flex justify-end">
              <Button size="sm" onClick={save} disabled={saving || !dirty}>
                {saving ? <Loader2 className="size-4 animate-spin" /> : <Save className="size-4" />}
                Save
              </Button>
            </div>
          </>
        )}
      </div>
    </Card>
  );
}
