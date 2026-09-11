import { useEffect, useState } from "react";
import {
  Loader2,
  MessageSquare,
  CheckCircle2,
  Pencil,
  Zap,
  Send,
  Copy,
  Check,
  Save,
  X,
  RefreshCw,
  Hash,
  Building2,
  KeyRound,
  ShieldCheck,
  Lock,
  Webhook,
  type LucideIcon,
} from "lucide-react";
import { toast } from "sonner";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { PasswordInput } from "@/components/ui/password-input";
import { api, ApiError, type IntegrationView } from "@/lib/api";
import { cn } from "@/lib/utils";

// Keys shown in the read-only summary, in display order. `agentUserId` is shown
// only when set (see below), so it's intentionally excluded here.
const SUMMARY_KEYS = [
  "whatsapp.phoneNumberId",
  "whatsapp.businessAccountId",
  "whatsapp.accessToken",
  "whatsapp.verifyToken",
  "whatsapp.appSecret",
];

// Per-field glyphs so each credential row reads at a glance.
const FIELD_ICONS: Record<string, LucideIcon> = {
  "whatsapp.phoneNumberId": Hash,
  "whatsapp.businessAccountId": Building2,
  "whatsapp.accessToken": KeyRound,
  "whatsapp.verifyToken": ShieldCheck,
  "whatsapp.appSecret": Lock,
};

type BusyAction = "save" | "verify" | "test" | null;

export function WhatsAppSettings() {
  const [view, setView] = useState<IntegrationView | null>(null);
  const [webhookUrl, setWebhookUrl] = useState("");
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState<BusyAction>(null);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [showTest, setShowTest] = useState(false);
  const [testTo, setTestTo] = useState("");
  const [copied, setCopied] = useState(false);
  const [copiedToken, setCopiedToken] = useState(false);
  const [lastGeneratedToken, setLastGeneratedToken] = useState("");

  async function load() {
    try {
      const [list, info] = await Promise.all([api.admin.integrations(), api.admin.whatsAppInfo()]);
      setView(list.find((i) => i.id === "whatsapp") ?? null);
      setWebhookUrl(info.webhookUrl);
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "Failed to load WhatsApp settings");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  function startEdit() {
    if (!view) return;
    const d: Record<string, string> = {};
    for (const f of view.fields) d[f.key] = "";
    setDraft(d);
    setEditing(true);
  }

  async function save() {
    if (!view) return;
    const updates: Record<string, string> = {};
    for (const f of view.fields) {
      const val = (draft[f.key] ?? "").trim();
      if (val) updates[f.key] = val;
    }
    setBusy("save");
    try {
      const list = await api.admin.saveIntegrations(updates);
      setView(list.find((i) => i.id === "whatsapp") ?? null);
      setEditing(false);
      toast.success("WhatsApp settings saved");
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "Failed to save");
    } finally {
      setBusy(null);
    }
  }

  async function testConnection() {
    setBusy("verify");
    try {
      const res = await api.admin.verifyWhatsApp();
      if (res.success) toast.success(res.message);
      else toast.error(res.message);
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "Connection test failed");
    } finally {
      setBusy(null);
    }
  }

  async function sendTest() {
    if (!testTo.trim()) {
      toast.error("Enter a recipient number first");
      return;
    }
    setBusy("test");
    try {
      const res = await api.admin.testWhatsApp(testTo.trim());
      if (res.success) toast.success(res.message);
      else toast.error(res.message);
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "Failed to send test message");
    } finally {
      setBusy(null);
    }
  }

  function generateVerifyToken() {
    const bytes = crypto.getRandomValues(new Uint8Array(32));
    const token = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
    setDraft((d) => ({ ...d, "whatsapp.verifyToken": token }));
    setLastGeneratedToken(token);
  }

  async function copyToken() {
    if (!lastGeneratedToken) return;
    try {
      await navigator.clipboard.writeText(lastGeneratedToken);
      setCopiedToken(true);
      setTimeout(() => setCopiedToken(false), 1500);
    } catch {
      toast.error("Couldn't copy — select and copy manually");
    }
  }

  async function copyUrl() {
    try {
      await navigator.clipboard.writeText(webhookUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      toast.error("Couldn't copy — select and copy manually");
    }
  }

  if (loading) {
    return (
      <Card className="flex h-44 items-center justify-center text-muted-foreground">
        <Loader2 className="size-5 animate-spin" />
      </Card>
    );
  }

  if (!view) return null;

  const connected = view.connected;
  const fieldByKey = new Map(view.fields.map((f) => [f.key, f]));
  const agentField = fieldByKey.get("whatsapp.agentUserId");

  return (
    <Card className="overflow-hidden rounded-none border-0 bg-transparent shadow-none sm:rounded-[var(--radius-card)] sm:border sm:border-border sm:bg-card sm:shadow-[var(--shadow-soft)]">
      {/* ---- Header ---- */}
      <div className="border-b border-border px-0 py-4 sm:bg-card sm:px-6 sm:py-5">
        <div className="flex flex-col items-start gap-2.5 sm:flex-row sm:items-start sm:justify-between sm:gap-3">
          <div className="flex flex-col items-start gap-2.5 sm:flex-row sm:items-center sm:gap-3.5">
            <span className="grid size-12 shrink-0 aspect-square place-items-center rounded-2xl bg-success/15 text-success shadow-[inset_0_0_0_1px_hsl(142_71%_45%/0.25)]">
              <MessageSquare className="size-6" />
            </span>
            <div>
              <p className="text-lg font-semibold leading-tight tracking-tight">WhatsApp (Meta)</p>
              <p className="mt-0.5 text-xs text-muted-foreground">
                Platform-wide WhatsApp Business · Meta Cloud API
              </p>
            </div>
          </div>
          {connected ? (
            <span className="inline-flex items-center gap-1.5 rounded-full border border-success/30 bg-success-tint px-3 py-1 text-xs font-medium text-success">
              <span className="animate-live size-2 rounded-full bg-success" /> Connected
            </span>
          ) : (
            <span className="inline-flex items-center gap-1.5 rounded-full border border-border bg-muted px-3 py-1 text-xs font-medium text-muted-foreground">
              <span className="size-2 rounded-full bg-muted-foreground/50" /> Not connected
            </span>
          )}
        </div>

        {connected && !editing && (
          <p className="mt-3 flex items-center gap-1.5 text-[11px] font-medium text-success">
            <CheckCircle2 className="size-3.5" /> Saved from UI override · secrets encrypted at rest
          </p>
        )}
      </div>

      <div className="space-y-5 px-0 py-4 sm:p-6">
        {editing ? (
          /* ---- Edit form ---- */
          <div className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-2">
              {view.fields.map((f) => {
                const Icon = FIELD_ICONS[f.key] ?? KeyRound;
                return (
                  <div key={f.key} className="space-y-1.5">
                    <Label
                      htmlFor={f.key}
                      className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground"
                    >
                      <Icon className="size-3.5" />
                      {f.label}
                    </Label>
                    <div className="flex items-center gap-1.5">
                      <PasswordInput
                        id={f.key}
                        className="flex-1"
                        placeholder={
                          f.isSet ? f.value || "••••••••" : `Enter ${f.label.toLowerCase()}`
                        }
                        value={draft[f.key] ?? ""}
                        onChange={(e) => setDraft((d) => ({ ...d, [f.key]: e.target.value }))}
                      />
                      {f.key === "whatsapp.verifyToken" && (
                        <Button
                          type="button"
                          variant="outline"
                          size="icon"
                          className="shrink-0"
                          onClick={generateVerifyToken}
                          title="Generate random token"
                        >
                          <RefreshCw className="size-4" />
                        </Button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
            <p className="rounded-lg bg-muted/60 px-3 py-2 text-[11px] text-muted-foreground">
              Leave a field blank to keep its current value. Secrets are encrypted at rest.
            </p>
            <div className="flex items-center justify-end gap-2">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setEditing(false)}
                disabled={busy === "save"}
              >
                <X className="size-4" /> Cancel
              </Button>
              <Button size="sm" onClick={save} disabled={busy === "save"}>
                {busy === "save" ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : (
                  <Save className="size-4" />
                )}
                Save changes
              </Button>
            </div>
          </div>
        ) : (
          /* ---- Read-only summary ---- */
          <>
            <div className="divide-y divide-border overflow-hidden rounded-[var(--radius-card)] border border-border bg-warm/50">
              {SUMMARY_KEYS.map((key) => {
                const f = fieldByKey.get(key);
                if (!f) return null;
                const Icon = FIELD_ICONS[key] ?? KeyRound;
                const showCopy = key === "whatsapp.verifyToken" && f.isSet && lastGeneratedToken;
                return (
                  <div
                    key={key}
                    className="flex items-center justify-between gap-3 px-4 py-3 transition-colors hover:bg-muted/40"
                  >
                    <span className="flex items-center gap-2.5 text-xs text-muted-foreground">
                      <Icon className="size-4 text-muted-foreground/70" />
                      {f.label}
                    </span>
                    <span className="flex items-center gap-1.5">
                      <span
                        className={cn(
                          "rounded-md bg-muted px-2 py-0.5 font-mono text-xs tracking-tight",
                          f.isSet
                            ? "text-foreground"
                            : "italic text-muted-foreground/60",
                        )}
                      >
                        {f.isSet ? f.value : "Not set"}
                      </span>
                      {showCopy && (
                        <button
                          type="button"
                          onClick={copyToken}
                          className="inline-flex items-center rounded p-0.5 text-muted-foreground hover:text-foreground"
                          title="Copy verify token"
                        >
                          {copiedToken ? (
                            <Check className="size-3.5 text-success" />
                          ) : (
                            <Copy className="size-3.5" />
                          )}
                        </button>
                      )}
                    </span>
                  </div>
                );
              })}
              {agentField?.isSet && (
                <div className="flex items-center justify-between gap-3 px-4 py-3">
                  <span className="flex items-center gap-2.5 text-xs text-muted-foreground">
                    <KeyRound className="size-4 text-muted-foreground/70" />
                    {agentField.label}
                  </span>
                  <span className="rounded-md bg-muted px-2 py-0.5 font-mono text-xs">
                    {agentField.value}
                  </span>
                </div>
              )}
            </div>

            {/* Actions */}
            <div className="grid gap-2 sm:grid-cols-3">
              <Button variant="outline" className="lift justify-center" onClick={startEdit}>
                <Pencil className="size-4" /> {connected ? "Update" : "Configure"}
              </Button>
              <Button
                variant="outline"
                className="lift justify-center"
                onClick={testConnection}
                disabled={!connected || busy === "verify"}
              >
                {busy === "verify" ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : (
                  <Zap className="size-4" />
                )}
                Test connection
              </Button>
              <Button
                variant="outline"
                className={cn("lift justify-center", showTest && "border-primary/40 text-primary")}
                onClick={() => setShowTest((v) => !v)}
                disabled={!connected}
              >
                <Send className="size-4" /> Send test
              </Button>
            </div>

            {showTest && (
              <div className="animate-in flex items-center gap-2 rounded-[var(--radius-card)] border border-border bg-warm/50 p-3">
                <Input
                  placeholder="+14155551234"
                  value={testTo}
                  onChange={(e) => setTestTo(e.target.value)}
                />
                <Button
                  size="sm"
                  className="shrink-0"
                  onClick={sendTest}
                  disabled={busy === "test"}
                >
                  {busy === "test" ? (
                    <Loader2 className="size-4 animate-spin" />
                  ) : (
                    <Send className="size-4" />
                  )}
                  Send
                </Button>
              </div>
            )}

            {/* Callback URL */}
            <div className="rounded-[var(--radius-card)] border border-dashed border-border bg-primary-tint-soft p-4">
              <p className="mb-2 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                <Webhook className="size-3.5" /> Inbound webhook · Callback URL
              </p>
              <div className="flex items-center gap-2">
                <code className="flex-1 break-all rounded-lg border border-border bg-card px-3 py-2.5 font-mono text-xs">
                  {webhookUrl || "Set PUBLIC_API_URL on the server to show this"}
                </code>
                <Button
                  variant="outline"
                  size="icon"
                  className="shrink-0"
                  onClick={copyUrl}
                  disabled={!webhookUrl}
                  aria-label="Copy callback URL"
                >
                  {copied ? <Check className="size-4 text-success" /> : <Copy className="size-4" />}
                </Button>
              </div>
              <p className="mt-2 text-[11px] text-muted-foreground">
                Paste this + your Verify Token into Meta → your App → WhatsApp → Configuration →
                Webhooks.
              </p>
            </div>
          </>
        )}
      </div>
    </Card>
  );
}
