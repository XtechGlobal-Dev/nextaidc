import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import {
  Bot,
  ChevronLeft,
  ChevronRight,
  Code2,
  CreditCard,
  Loader2,
  Palette,
  Plug,
  KeyRound,
  Save,
  Trash2,
  Send,
  Phone,
  AudioLines,
  Sparkles,
  Mail,
  MessageCircle,
  Briefcase,
  Volume2,
  CalendarDays,
  type LucideIcon,
} from "lucide-react";
import { toast } from "sonner";
import { PageHeader } from "@/components/layout/PageHeader";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { PasswordInput } from "@/components/ui/password-input";
import { api, ApiError, type IntegrationView } from "@/lib/api";
import { cn } from "@/lib/utils";
import { useAuthStore } from "@/stores/useAuthStore";
import { isSuperAdminRole } from "@/lib/roles";
import { BrandingSettings } from "./BrandingSettings";
import { MasterPromptSettings } from "./MasterPromptSettings";
import { SeoSettings } from "./SeoSettings";
import { CountryStyleSettings } from "./CountryStyleSettings";
import { IndustrySuggestionsSettings } from "./IndustrySuggestionsSettings";
import { AgentDefaultsSettings } from "./AgentDefaultsSettings";
import { AgentModelSettings } from "./AgentModelSettings";
import { TranscriberFallbackSettings } from "./TranscriberFallbackSettings";
import { OnboardingSettings } from "./OnboardingSettings";
import { WhatsAppSettings } from "./WhatsAppSettings";

// Per-service glyph + accent so each card reads at a glance instead of a wall of
// identical green keys. Colour is a design-token CSS var; the tile tints it softly.
const INTEGRATION_META: Record<string, { icon: LucideIcon; color: string }> = {
  vapi: { icon: Phone, color: "var(--color-step-2)" },
  deepgram: { icon: AudioLines, color: "var(--color-step-5)" },
  elevenlabs: { icon: Volume2, color: "var(--color-step-6)" },
  openai: { icon: Sparkles, color: "var(--color-step-3)" },
  email: { icon: Mail, color: "var(--color-step-4)" },
  twilio: { icon: MessageCircle, color: "var(--color-danger)" },
  perfex: { icon: Briefcase, color: "var(--color-muted-foreground)" },
  google: { icon: CalendarDays, color: "var(--color-step-1)" },
};

/** Settings sections, grouped into tabs so the page isn't one long scroll. */
const SETTINGS_TABS = ["integrations", "agent", "onboarding", "branding", "seo"] as const;
type SettingsTab = (typeof SETTINGS_TABS)[number];

/**
 * Integrations is the one tab a brand admin never sees: it holds the platform's
 * provider credentials (Vapi, Twilio, SMTP, OpenAI …), which are the platform
 * owner's and are billed to them. The other four configure how the product
 * behaves and looks, and hold no secrets.
 *
 * The API enforces the same split independently — `/admin/integrations*` stays
 * on requireSuperAdmin while the rest moved to requireAdmin.
 */
const SUPER_ADMIN_TABS = new Set<SettingsTab>(["integrations"]);

const TAB_META: Record<SettingsTab, { label: string; icon: LucideIcon }> = {
  integrations: { label: "Integrations", icon: Plug },
  agent: { label: "AI Agent", icon: Bot },
  onboarding: { label: "Onboarding", icon: CreditCard },
  branding: { label: "Branding", icon: Palette },
  seo: { label: "SEO & Scripts", icon: Code2 },
};

export default function AdminSettingsPage() {
  const isSuperAdmin = useAuthStore((s) => isSuperAdminRole(s.user?.role));
  const tabs = useMemo(
    () => SETTINGS_TABS.filter((t) => isSuperAdmin || !SUPER_ADMIN_TABS.has(t)),
    [isSuperAdmin],
  );
  const [views, setViews] = useState<IntegrationView[]>([]);
  const [loading, setLoading] = useState(true);
  // Active tab lives in the URL (?tab=agent) so sections are deep-linkable and
  // survive a refresh. A tab this account can't open (a shared ?tab=integrations
  // link) falls back to their first one rather than rendering an empty panel.
  const [searchParams, setSearchParams] = useSearchParams();
  const rawTab = searchParams.get("tab") as SettingsTab | null;
  const tab: SettingsTab = rawTab && tabs.includes(rawTab) ? rawTab : tabs[0];
  const setTab = (value: string) =>
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        next.set("tab", value);
        return next;
      },
      { replace: true },
    );
  // Which integration card is mid-action (so only its buttons spin).
  const [busy, setBusy] = useState<{ id: string; action: "save" | "clear" | "test" } | null>(null);
  // Clearing wipes saved keys immediately, so confirm which integration first.
  const [confirmClear, setConfirmClear] = useState<IntegrationView | null>(null);
  // Values the admin has typed (key -> value). Secret fields stay empty until edited.
  const [draft, setDraft] = useState<Record<string, string>>({});

  function seedDraft(list: IntegrationView[]) {
    const d: Record<string, string> = {};
    for (const integ of list) {
      for (const f of integ.fields) {
        // Every field is masked — start blank; type to change, leave to keep.
        d[f.key] = "";
      }
    }
    setDraft(d);
  }

  useEffect(() => {
    let active = true;
    if (!isSuperAdmin) {
      // No Integrations tab for them, so there is nothing to fetch — and asking
      // anyway would 403 and throw a toast on every visit.
      setLoading(false);
      return;
    }
    (async () => {
      try {
        const list = await api.admin.integrations();
        if (!active) return;
        setViews(list);
        seedDraft(list);
      } catch (e) {
        toast.error(e instanceof ApiError ? e.message : "Failed to load integrations");
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => {
      active = false;
    };
  }, [isSuperAdmin]);

  async function saveIntegration(integ: IntegrationView) {
    // Build updates for this card only — every field is masked, so send a value
    // only when the admin actually typed one. Untouched fields keep their value.
    const updates: Record<string, string> = {};
    for (const f of integ.fields) {
      const val = draft[f.key] ?? "";
      if (val.trim()) updates[f.key] = val;
    }
    setBusy({ id: integ.id, action: "save" });
    try {
      const list = await api.admin.saveIntegrations(updates);
      setViews(list);
      seedDraft(list);
      toast.success(`${integ.name} saved`);
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "Failed to save keys");
    } finally {
      setBusy(null);
    }
  }

  async function testEmail(integ: IntegrationView) {
    setBusy({ id: integ.id, action: "test" });
    try {
      const res = await api.admin.testEmail();
      toast.success(`Test email sent to ${res.to ?? "your inbox"} — check your inbox.`);
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "Failed to send test email");
    } finally {
      setBusy(null);
    }
  }

  async function clearIntegration(integ: IntegrationView) {
    setBusy({ id: integ.id, action: "clear" });
    try {
      const list = await api.admin.clearIntegration(integ.id);
      setViews(list);
      seedDraft(list);
      toast.success(`${integ.name} keys cleared`);
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "Failed to clear keys");
    } finally {
      setBusy(null);
    }
  }

  if (loading) {
    return (
      <div className="flex h-[60vh] items-center justify-center text-muted-foreground">
        <Loader2 className="size-6 animate-spin" />
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <PageHeader
        title="Platform Settings"
        subtitle={
          isSuperAdmin
            ? "Integrations, AI agent, branding & SEO — everything that powers the platform. Provider credentials are super-admin only."
            : "AI agent, onboarding, branding & SEO. These settings are shared by every brand on the platform — a change here applies to all of them."
        }
      />

      <Tabs value={tab} onValueChange={setTab}>
        {/* Mobile: the strip doesn't fit, so show only the open tab's label with
            prev/next arrows to step through the sections. */}
        {(() => {
          const idx = tabs.indexOf(tab);
          const prev = idx > 0 ? tabs[idx - 1] : null;
          const next = idx < tabs.length - 1 ? tabs[idx + 1] : null;
          const ActiveIcon = TAB_META[tab].icon;
          return (
            <div className="flex items-center justify-between gap-1 rounded-lg bg-muted p-1 sm:hidden">
              <Button
                variant="ghost"
                size="sm"
                className="shrink-0 text-muted-foreground"
                disabled={!prev}
                onClick={() => prev && setTab(prev)}
                aria-label={prev ? `Previous: ${TAB_META[prev].label}` : "Previous tab"}
              >
                <ChevronLeft className="size-4" />
              </Button>
              <span className="inline-flex min-w-0 items-center gap-2 rounded-md bg-background px-3 py-1.5 text-sm font-medium text-primary shadow-sm">
                <ActiveIcon className="size-4 shrink-0" />
                <span className="truncate">{TAB_META[tab].label}</span>
              </span>
              <Button
                variant="ghost"
                size="sm"
                className="shrink-0 text-muted-foreground"
                disabled={!next}
                onClick={() => next && setTab(next)}
                aria-label={next ? `Next: ${TAB_META[next].label}` : "Next tab"}
              >
                <ChevronRight className="size-4" />
              </Button>
            </div>
          );
        })()}

        {/* Desktop: the full tab strip. */}
        <TabsList className="hidden sm:inline-flex">
          {tabs.map((t) => {
            const Icon = TAB_META[t].icon;
            return (
              <TabsTrigger key={t} value={t}>
                <Icon className="size-4" /> {TAB_META[t].label}
              </TabsTrigger>
            );
          })}
        </TabsList>

        <TabsContent value="integrations" className="mt-5">
      <Card className="overflow-hidden rounded-none border-0 bg-transparent shadow-none sm:rounded-[var(--radius-card)] sm:border sm:border-border sm:bg-card sm:shadow-[var(--shadow-soft)]">
        {/* ---- Header ---- */}
        <div className="border-b border-border px-0 py-4 sm:bg-card sm:px-6 sm:py-5">
          <div className="flex flex-col items-start gap-2.5 sm:flex-row sm:items-center sm:gap-3.5">
            <span className="grid size-11 shrink-0 place-items-center rounded-2xl bg-primary/15 text-primary shadow-[inset_0_0_0_1px_hsl(217_84%_55%/0.25)] sm:size-12">
              <Plug className="size-5 sm:size-6" />
            </span>
            <div>
              <p className="text-lg font-semibold leading-tight tracking-tight">
                Integrations &amp; API Keys
              </p>
              <p className="mt-0.5 text-xs text-muted-foreground">
                Connected services that power the platform.
              </p>
            </div>
          </div>
        </div>
        <div className="space-y-4 px-0 py-4 sm:p-6">
          {/* Masonry columns so short cards (e.g. CRM) don't leave a big gap next
              to a tall neighbour — cards pack tightly down each column. */}
          <div className="gap-4 lg:columns-2 [&>*]:mb-4 [&>*]:break-inside-avoid">
          {views.filter((integ) => integ.id !== "whatsapp").map((integ) => {
            const meta = INTEGRATION_META[integ.id];
            const Icon = meta?.icon ?? KeyRound;
            const accent = meta?.color ?? "var(--color-muted-foreground)";
            return (
            <div
              key={integ.id}
              className="lift flex flex-col overflow-hidden rounded-[var(--radius-card)] border border-border bg-card hover:border-primary/30"
            >
              {/* header */}
              <div className="flex items-start justify-between gap-3 px-4 pt-4">
                <div className="flex min-w-0 flex-col items-start gap-2 sm:flex-row sm:items-center sm:gap-3">
                  <span
                    className="grid size-10 shrink-0 place-items-center rounded-xl"
                    style={{
                      color: accent,
                      backgroundColor: `color-mix(in srgb, ${accent} 14%, transparent)`,
                    }}
                  >
                    <Icon className="size-5" />
                  </span>
                  <div className="min-w-0">
                    <p className="truncate text-sm font-semibold leading-tight">{integ.name}</p>
                    <p className="truncate text-xs text-muted-foreground">{integ.description}</p>
                  </div>
                </div>
                {integ.connected ? (
                  <span className="inline-flex shrink-0 items-center gap-1.5 rounded-full border border-success/30 bg-success-tint px-2.5 py-1 text-xs font-medium text-success">
                    <span className="animate-live size-1.5 rounded-full bg-success" /> Connected
                  </span>
                ) : (
                  <span className="inline-flex shrink-0 items-center gap-1.5 rounded-full border border-border bg-muted px-2.5 py-1 text-xs font-medium text-muted-foreground">
                    <span className="size-1.5 rounded-full bg-muted-foreground/50" /> Not connected
                  </span>
                )}
              </div>

              {/* fields */}
              <div className="grid flex-1 gap-3 px-4 py-4 sm:grid-cols-2">
                {integ.fields.map((f) => (
                  <div key={f.key} className={cn("space-y-1.5", integ.fields.length === 1 && "sm:col-span-2")}>
                    <Label htmlFor={f.key} className="text-xs text-muted-foreground">
                      {f.label}
                    </Label>
                    <PasswordInput
                      id={f.key}
                      placeholder={f.isSet ? f.value || "••••••••" : `Enter ${f.label.toLowerCase()}`}
                      value={draft[f.key] ?? ""}
                      onChange={(e) => setDraft((d) => ({ ...d, [f.key]: e.target.value }))}
                    />
                  </div>
                ))}
              </div>

              {/* footer */}
              <div className="flex flex-wrap items-center justify-end gap-2 border-t border-border bg-warm/60 px-4 py-3">
                {integ.id === "email" && (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="mr-auto text-primary hover:bg-primary-tint hover:text-primary"
                    onClick={() => testEmail(integ)}
                    disabled={busy?.id === integ.id || !integ.connected}
                    title={integ.connected ? "Send a test email to yourself" : "Save SMTP settings first"}
                  >
                    {busy?.id === integ.id && busy.action === "test" ? (
                      <Loader2 className="size-4 animate-spin" />
                    ) : (
                      <Send className="size-4" />
                    )}
                    Send test
                  </Button>
                )}
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-danger hover:bg-danger-tint hover:text-danger"
                  onClick={() => setConfirmClear(integ)}
                  disabled={busy?.id === integ.id || !integ.connected}
                >
                  {busy?.id === integ.id && busy.action === "clear" ? (
                    <Loader2 className="size-4 animate-spin" />
                  ) : (
                    <Trash2 className="size-4" />
                  )}
                  Clear
                </Button>
                <Button
                  size="sm"
                  onClick={() => saveIntegration(integ)}
                  disabled={busy?.id === integ.id}
                >
                  {busy?.id === integ.id && busy.action === "save" ? (
                    <Loader2 className="size-4 animate-spin" />
                  ) : (
                    <Save className="size-4" />
                  )}
                  Save
                </Button>
              </div>
            </div>
            );
          })}
          <WhatsAppSettings />
          </div>

          <p className="text-xs text-muted-foreground">
            Secret keys are encrypted at rest and never shown again — leave a field blank to keep its
            current value. <strong>Clear</strong> removes this integration's saved keys from the
            database (reverting to any <code>.env</code> fallback). Changes apply immediately.
          </p>
        </div>
      </Card>

      {/* Clearing keys is immediate and they can't be read back — confirm first. */}
      <Dialog
        open={!!confirmClear}
        onOpenChange={(o) => !o && busy?.action !== "clear" && setConfirmClear(null)}
      >
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Clear {confirmClear?.name} keys?</DialogTitle>
            <DialogDescription>
              This immediately removes the saved keys for{" "}
              <span className="font-medium text-foreground">{confirmClear?.name}</span> from the
              database (reverting to any <code>.env</code> fallback). Keys can't be recovered —
              you'll need to re-enter them to reconnect.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setConfirmClear(null)}
              disabled={busy?.action === "clear"}
            >
              Cancel
            </Button>
            <Button
              variant="danger"
              disabled={busy?.action === "clear"}
              onClick={async () => {
                if (!confirmClear) return;
                await clearIntegration(confirmClear);
                setConfirmClear(null);
              }}
            >
              {busy?.action === "clear" && <Loader2 className="size-4 animate-spin" />}
              Clear keys
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
        </TabsContent>

        <TabsContent value="agent" className="mt-5 space-y-6">
          <AgentModelSettings />
          <TranscriberFallbackSettings />
          <AgentDefaultsSettings />
          <MasterPromptSettings />
          <CountryStyleSettings />
          <IndustrySuggestionsSettings />
        </TabsContent>

        <TabsContent value="onboarding" className="mt-5 space-y-6">
          <OnboardingSettings />
        </TabsContent>

        <TabsContent value="branding" className="mt-5 space-y-6">
          <BrandingSettings />
        </TabsContent>

        <TabsContent value="seo" className="mt-5">
          <SeoSettings />
        </TabsContent>

      </Tabs>
    </div>
  );
}
