import { useEffect, useState } from "react";
import { Check, X, ChevronDown, Loader2, Lock, Package, Pencil, Plus, RefreshCw, Trash2, Clock, PhoneCall, MessageSquare, MessageCircle, Mic, LifeBuoy, Timer, DollarSign, SlidersHorizontal, Link2, Globe } from "lucide-react";
import { toast } from "sonner";
import { PageHeader } from "@/components/layout/PageHeader";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { CardSkeleton } from "@/components/ui/skeleton";
import { ConfirmDeleteDialog } from "@/components/ui/ConfirmDeleteDialog";
import { api, ApiError, type BillingInterval, type SubscriptionPlan, type VoiceCategory } from "@/lib/api";
import { formatMoney } from "@/lib/currency";
import {
  MONTHLY_INTERVAL_COUNTS,
  intervalLabel,
  intervalOptionLabel,
} from "@/lib/billingInterval";
import { buildPlanFeatureRows } from "@/lib/planFeatures";
import { cn } from "@/lib/utils";
import { useAuthStore } from "@/stores/useAuthStore";
import { isSuperAdminRole } from "@/lib/roles";

// Cycle lengths, in months. Stripe caps a recurring cycle at one year, so 12 is
// the ceiling; the unit stays "month" for every option (a 12-month cycle is
// month x 12, not interval="year") so the Stripe price and the minute allowance
// need no special case.
const INTERVAL_COUNTS = MONTHLY_INTERVAL_COUNTS;

// Currencies plans can be billed in. AUD first — it's the current pricing.
const CURRENCIES = ["aud", "usd"] as const;

function formatPrice(
  cents: number,
  currency: string,
  interval: BillingInterval,
  intervalCount = 1,
): string {
  return `${formatMoney(cents, currency)} / ${intervalLabel(interval, intervalCount)}`;
}

interface FormState {
  name: string;
  displayName: string;
  description: string;
  price: string; // whole currency units (dollars)
  currency: string; // ISO code, lowercase (e.g. "aud")
  interval: BillingInterval;
  intervalCount: number;
  includedMinutes: string;
  sortOrder: string;
  recommended: boolean;
  isDefault: boolean; // pre-selected on the onboarding subscribe page (only one plan)
  smsEnabled: boolean;
  smsToCallerEnabled: boolean;
  whatsappEnabled: boolean;
  customCrmEnabled: boolean;
  multilingualEnabled: boolean;
  transcriptsEnabled: boolean;
  callTransferEnabled: boolean;
  callTransferLimit: string; // max transfer departments; "0" = unlimited
  voiceCategoryId: string; // Voice Bank category this plan unlocks ("" = none)
  active: boolean;
}

const EMPTY_FORM: FormState = {
  name: "",
  displayName: "",
  description: "",
  price: "",
  currency: "aud",
  interval: "month",
  intervalCount: 1,
  includedMinutes: "",
  sortOrder: "0",
  recommended: false,
  isDefault: false,
  smsEnabled: false,
  smsToCallerEnabled: false,
  whatsappEnabled: false,
  customCrmEnabled: false,
  multilingualEnabled: false,
  transcriptsEnabled: true,
  callTransferEnabled: false,
  callTransferLimit: "0",
  voiceCategoryId: "",
  active: true,
};

function planToForm(p: SubscriptionPlan): FormState {
  return {
    name: p.name,
    displayName: p.displayName,
    description: p.description,
    price: (p.priceCents / 100).toString(),
    currency: (p.currency || "usd").toLowerCase(),
    interval: p.interval,
    intervalCount: p.intervalCount ?? 1,
    includedMinutes: String(p.includedMinutes ?? 0),
    // Clamp legacy negatives (e.g. an old -2) to 0 so the field shows a valid value.
    sortOrder: String(Math.max(0, p.sortOrder ?? 0)),
    recommended: p.recommended ?? false,
    isDefault: p.isDefault ?? false,
    smsEnabled: p.smsEnabled ?? false,
    smsToCallerEnabled: p.smsToCallerEnabled ?? false,
    whatsappEnabled: p.whatsappEnabled ?? false,
    customCrmEnabled: p.customCrmEnabled ?? false,
    multilingualEnabled: p.multilingualEnabled ?? false,
    transcriptsEnabled: p.transcriptsEnabled ?? true,
    callTransferEnabled: p.callTransferEnabled ?? false,
    callTransferLimit: String(p.callTransferLimit ?? 0),
    voiceCategoryId: p.voiceCategoryId ?? "",
    active: p.active,
  };
}

export default function AdminPlansPage() {
  const [plans, setPlans] = useState<SubscriptionPlan[] | null>(null);
  // The trial + grace controls on this page are platform-wide *settings* — one
  // value shared by every tenant — so they're SUPER_ADMIN-only, matching
  // requireSuperAdmin on the routes behind them. Anyone else (a staff member
  // with just "plans", or a brand admin running their own tenant) must still be
  // able to manage plans, so we only load/show those controls for the super
  // admin — otherwise their fetches 403 and blow up the whole page load with a
  // "no permission" toast.
  const hasPermission = useAuthStore((s) => s.hasPermission);
  const canManageSettings = useAuthStore((s) => isSuperAdminRole(s.user?.role));
  // Capability gates for the plan CRUD actions. ADMIN passes all; STAFF only
  // where the role grants it. Denied buttons are omitted from the DOM (not just
  // hidden) and the mutating handlers no-op as a defensive backstop.
  const canCreate = hasPermission("plans.create");
  const canEdit = hasPermission("plans.edit");
  const canDelete = hasPermission("plans.delete");

  const [trialDays, setTrialDays] = useState<number | null>(null);
  const [trialDraft, setTrialDraft] = useState("");
  const [trialMinutes, setTrialMinutes] = useState<number | null>(null);
  const [trialMinutesDraft, setTrialMinutesDraft] = useState("");
  const [savingTrial, setSavingTrial] = useState(false);
  const [graceEnabled, setGraceEnabled] = useState(true);
  const [graceDaysDraft, setGraceDaysDraft] = useState("");
  const [savingGrace, setSavingGrace] = useState(false);
  /* The values as the SERVER has them, kept beside the drafts so each card can
   * tell whether it is actually holding a change. Without a baseline a Save
   * button can only report "not currently saving", which is what left all three
   * permanently clickable — inviting a write that stores exactly what is
   * already stored. `null` until the settings load, which is also what keeps
   * the buttons off while the toggles are still showing their defaults. */
  const [graceSaved, setGraceSaved] = useState<{ enabled: boolean; days: string } | null>(null);
  // Platform-wide per-call ceiling. Stored in seconds, edited in minutes.
  const [capEnabled, setCapEnabled] = useState(false);
  const [capMinutesDraft, setCapMinutesDraft] = useState("");
  const [savingCap, setSavingCap] = useState(false);
  const [capSaved, setCapSaved] = useState<{ enabled: boolean; minutes: string } | null>(null);
  // Collapsed by default: this page is for managing plans, and these three are
  // set-once platform settings. The header carries their current values so the
  // common case — checking what they are — needs no click at all.
  const [settingsOpen, setSettingsOpen] = useState(false);

  /** One-line digest shown on the collapsed header, so checking these values
   *  needs no click. Blank until the settings have actually loaded — the toggles
   *  hold optimistic defaults before then, and showing those would state a grace
   *  period or call limit that may not be the real one. */
  const settingsLoaded = trialDays != null;

  /* Does this card hold an unsaved change? Each Save is disabled until its own
   * does, so the buttons stop reading as three permanently-available actions
   * and start meaning "there is something here to write".
   *
   * All three are false until the settings load: the drafts are empty strings
   * and the toggles hold optimistic defaults at that point, so anything else
   * would offer to save a value nobody has seen yet. Grace and cap compare the
   * toggle as well as the number — flipping Enabled is the change on those
   * cards, and the number input is disabled while the toggle is off. */
  const trialDirty =
    settingsLoaded &&
    (trialDraft !== String(trialDays) || trialMinutesDraft !== String(trialMinutes));
  const graceDirty =
    graceSaved != null &&
    (graceEnabled !== graceSaved.enabled || graceDaysDraft !== graceSaved.days);
  const capDirty =
    capSaved != null && (capEnabled !== capSaved.enabled || capMinutesDraft !== capSaved.minutes);
  const settingsSummary = !settingsLoaded
    ? ""
    : [
        `${trialDays}-day trial`,
        `${trialMinutes} trial min`,
        graceEnabled ? `${graceDaysDraft}-day grace` : "no grace",
        capEnabled ? `${capMinutesDraft} min max call` : "no call limit",
      ].join(" · ");
  const [syncing, setSyncing] = useState(false);

  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<SubscriptionPlan | null>(null);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [toDelete, setToDelete] = useState<SubscriptionPlan | null>(null);

  // Voice Bank categories — a plan unlocks one of these for its customers.
  const [categories, setCategories] = useState<VoiceCategory[]>([]);

  // Core Plans data — needs only the "plans" permission. Voice categories are a
  // best-effort extra (own permission), so a 403 there degrades to an empty list
  // rather than failing the page.
  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const [list, cats] = await Promise.all([
          api.admin.plans.list(),
          api.admin.voiceCategories.list().catch(() => [] as VoiceCategory[]),
        ]);
        if (!active) return;
        setPlans(list);
        setCategories(cats);
      } catch (e) {
        toast.error(e instanceof ApiError ? e.message : "Failed to load plans");
        if (active) setPlans([]);
      }
    })();
    return () => {
      active = false;
    };
  }, []);

  // Trial + grace settings — only for users who can manage settings (ADMIN).
  useEffect(() => {
    if (!canManageSettings) return;
    let active = true;
    (async () => {
      try {
        const [trial, trialMins, grace, cap] = await Promise.all([
          api.admin.trialDays.get(),
          api.admin.trialMinutes.get(),
          api.admin.gracePeriod.get(),
          api.admin.callDurationCap.get(),
        ]);
        if (!active) return;
        setTrialDays(trial.days);
        setTrialDraft(String(trial.days));
        setTrialMinutes(trialMins.minutes);
        setTrialMinutesDraft(String(trialMins.minutes));
        setGraceEnabled(grace.enabled);
        setGraceDaysDraft(String(grace.days));
        setGraceSaved({ enabled: grace.enabled, days: String(grace.days) });
        const capMinutes = String(Math.round(cap.seconds / 60));
        setCapEnabled(cap.enabled);
        setCapMinutesDraft(capMinutes);
        setCapSaved({ enabled: cap.enabled, minutes: capMinutes });
      } catch {
        /* settings are secondary here — leave the controls at their defaults */
      }
    })();
    return () => {
      active = false;
    };
  }, [canManageSettings]);

  function openCreate() {
    if (!canCreate) return;
    setEditing(null);
    setForm(EMPTY_FORM);
    setDialogOpen(true);
  }
  function openEdit(p: SubscriptionPlan) {
    if (!canEdit) return;
    setEditing(p);
    setForm(planToForm(p));
    setDialogOpen(true);
  }

  async function saveTrial() {
    const days = Number(trialDraft);
    const minutes = Number(trialMinutesDraft);
    if (!Number.isInteger(days) || days < 1 || days > 365) {
      toast.error("Trial days must be a whole number (1–365)");
      return;
    }
    if (!Number.isInteger(minutes) || minutes < 1) {
      toast.error("Trial minutes must be a whole number of at least 1");
      return;
    }
    setSavingTrial(true);
    try {
      if (days !== trialDays) {
        const res = await api.admin.trialDays.set(days);
        setTrialDays(res.days);
        setTrialDraft(String(res.days));
      }
      if (minutes !== trialMinutes) {
        const res = await api.admin.trialMinutes.set(minutes);
        setTrialMinutes(res.minutes);
        setTrialMinutesDraft(String(res.minutes));
      }
      toast.success("Trial limits saved");
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "Failed to save trial limits");
    } finally {
      setSavingTrial(false);
    }
  }

  async function saveCallCap() {
    const minutes = Number(capMinutesDraft);
    // Mirrors the server's bounds (60s–3600s). Below a minute the ceiling stops
    // being an abuse control and starts cutting ordinary conversations.
    if (!Number.isInteger(minutes) || minutes < 1 || minutes > 60) {
      toast.error("Call limit must be a whole number of minutes (1–60)");
      return;
    }
    setSavingCap(true);
    try {
      const res = await api.admin.callDurationCap.set(capEnabled, minutes * 60);
      const savedMinutes = String(Math.round(res.seconds / 60));
      setCapEnabled(res.enabled);
      setCapMinutesDraft(savedMinutes);
      // The new baseline, so the button goes quiet again the moment it lands.
      setCapSaved({ enabled: res.enabled, minutes: savedMinutes });
      toast.success(
        res.enabled
          ? `Call limit saved — calls now end after ${Math.round(res.seconds / 60)} min`
          : "Call limit turned off",
      );
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "Failed to save call limit");
    } finally {
      setSavingCap(false);
    }
  }

  async function saveGrace() {
    const days = Number(graceDaysDraft);
    if (!Number.isInteger(days) || days < 1 || days > 90) {
      toast.error("Grace days must be a whole number (1–90)");
      return;
    }
    setSavingGrace(true);
    try {
      const res = await api.admin.gracePeriod.set(graceEnabled, days);
      setGraceEnabled(res.enabled);
      setGraceDaysDraft(String(res.days));
      setGraceSaved({ enabled: res.enabled, days: String(res.days) });
      toast.success("Grace period saved");
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "Failed to save grace period");
    } finally {
      setSavingGrace(false);
    }
  }

  async function submit() {
    if (editing ? !canEdit : !canCreate) return;
    if (!form.name.trim() || !form.displayName.trim()) {
      toast.error("Plan key and display name are required");
      return;
    }
    const dollars = parseFloat(form.price);
    if (Number.isNaN(dollars) || dollars < 0) {
      toast.error("Enter a valid price");
      return;
    }
    const includedMinutes = Math.floor(Number(form.includedMinutes));
    if (!Number.isInteger(includedMinutes) || includedMinutes < 0) {
      toast.error("Included minutes must be a whole number (0 or more)");
      return;
    }
    // Only validated when the feature is on — the field is hidden otherwise and
    // its value is ignored server-side.
    const callTransferLimit = Math.floor(Number(form.callTransferLimit || 0));
    if (form.callTransferEnabled && (!Number.isInteger(callTransferLimit) || callTransferLimit < 0)) {
      toast.error("Call transfer departments must be a whole number (0 = unlimited)");
      return;
    }
    // Non-negative whole number — negatives confuse admins and the server rejects
    // them; clamp defensively so a stray "-" can never be submitted.
    const sortOrder = Math.max(0, Math.floor(Number(form.sortOrder) || 0));
    const payload = {
      name: form.name.trim(),
      displayName: form.displayName.trim(),
      description: form.description.trim(),
      priceCents: Math.round(dollars * 100),
      currency: form.currency,
      interval: form.interval,
      intervalCount: form.intervalCount,
      includedMinutes,
      sortOrder,
      recommended: form.recommended,
      isDefault: form.isDefault,
      smsEnabled: form.smsEnabled,
      smsToCallerEnabled: form.smsToCallerEnabled,
      whatsappEnabled: form.whatsappEnabled,
      customCrmEnabled: form.customCrmEnabled,
      multilingualEnabled: form.multilingualEnabled,
      transcriptsEnabled: form.transcriptsEnabled,
      callTransferEnabled: form.callTransferEnabled,
      callTransferLimit: form.callTransferEnabled ? callTransferLimit : 0,
      voiceCategoryId: form.voiceCategoryId || null,
      active: form.active,
    };
    setSaving(true);
    try {
      // Only one plan is the onboarding default — when this save sets it, the
      // server clears the flag on the others, so mirror that locally.
      const clearOtherDefaults = (list: SubscriptionPlan[], keptId: string) =>
        payload.isDefault ? list.map((p) => (p.id === keptId ? p : { ...p, isDefault: false })) : list;
      if (editing) {
        const updated = await api.admin.plans.update(editing.id, payload);
        setPlans((prev) =>
          clearOtherDefaults(
            (prev ?? []).map((p) => (p.id === editing.id ? updated : p)),
            editing.id,
          ),
        );
        toast.success("Plan updated");
      } else {
        const created = await api.admin.plans.create(payload);
        setPlans((prev) => clearOtherDefaults([...(prev ?? []), created], created.id));
        toast.success("Plan created");
      }
      setDialogOpen(false);
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "Failed to save plan");
    } finally {
      setSaving(false);
    }
  }

  async function confirmDelete() {
    if (!toDelete || !canDelete) return;
    await api.admin.plans.remove(toDelete.id);
    setPlans((prev) => (prev ?? []).filter((p) => p.id !== toDelete.id));
    toast.success(`${toDelete.displayName} deleted`);
  }

  async function syncToStripe() {
    setSyncing(true);
    try {
      const { results } = await api.admin.plans.syncStripe();
      const ok = results.filter((r) => r.synced).length;
      const fail = results.filter((r) => !r.synced);
      if (fail.length) {
        toast.error(`${fail.length} plan(s) failed to sync: ${fail.map((f) => f.name).join(", ")}`);
      } else {
        toast.success(`${ok} plan(s) synced to Stripe`);
      }
      const refreshed = await api.admin.plans.list();
      setPlans(refreshed);
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "Stripe sync failed");
    } finally {
      setSyncing(false);
    }
  }

  return (
    <div>
      <PageHeader
        title="Plans"
        subtitle="Create the subscription plans customers choose at signup."
        actions={
          canCreate || canEdit ? (
            <div className="flex gap-2">
              {canEdit && (
                <Button variant="outline" onClick={syncToStripe} disabled={syncing || !plans?.length}>
                  {syncing ? <Loader2 className="size-4 animate-spin" /> : <RefreshCw className="size-4" />}
                  Sync to Stripe
                </Button>
              )}
              {canCreate && (
                <Button onClick={openCreate}>
                  <Plus className="size-4" /> New plan
                </Button>
              )}
            </div>
          ) : undefined
        }
      />

      {/* Global platform settings — trial limits, grace period and the per-call
          ceiling. Only users who can manage settings (ADMIN) see them.
          Collapsed into a single bar by default: they're set-once values that
          were pushing the actual plans below the fold.
          Built as ONE bordered panel — header and tray share a border, and the
          tray is tinted with the inner cards' shadows dropped. Given their own
          border and shadow outside that panel, they read as three unrelated
          cards that happen to sit below a bar, not as its contents. */}
      {canManageSettings && (
      <div className="mb-6 overflow-hidden rounded-[var(--radius-card)] border border-border bg-card shadow-[var(--shadow-soft)]">
        <button
          type="button"
          onClick={() => setSettingsOpen((v) => !v)}
          aria-expanded={settingsOpen}
          className="flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-muted/40"
        >
          <SlidersHorizontal className="size-4 shrink-0 text-muted-foreground" />
          <span className="text-sm font-semibold">Platform settings</span>
          <span className="hidden truncate text-xs text-muted-foreground sm:inline">
            {settingsSummary}
          </span>
          <ChevronDown
            className={cn(
              "ml-auto size-4 shrink-0 text-muted-foreground transition-transform",
              settingsOpen && "rotate-180",
            )}
          />
        </button>

        {settingsOpen && (
        <div className="grid gap-3 border-t border-border/60 bg-muted/20 p-3 md:grid-cols-2 xl:grid-cols-3">
        {/* Free trial limits */}
        <Card className="flex flex-col overflow-hidden p-0 shadow-none">
          <div className="flex flex-col gap-2.5 border-b border-border/60 px-4 py-3 sm:flex-row sm:items-start sm:gap-3">
            <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-primary-tint text-primary">
              <Clock className="size-4" />
            </span>
            <div>
              <h3 className="text-sm font-semibold leading-tight">Free trial limits</h3>
              <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
                Applies to every plan. Customers are charged automatically when the trial ends —
                whichever limit (days or call minutes) is reached first.
              </p>
            </div>
          </div>

          <div className="flex-1 divide-y divide-border/60 px-4">
            <div className="flex items-center justify-between gap-3 py-2.5">
              <Label htmlFor="trial-days" className="text-sm font-medium">
                Trial length
              </Label>
              <div className="relative">
                <Input
                  id="trial-days"
                  type="number"
                  min={1}
                  max={365}
                  value={trialDraft}
                  onChange={(e) => setTrialDraft(e.target.value)}
                  className="w-28 pr-12 text-right"
                />
                <span className="pointer-events-none absolute inset-y-0 right-3 flex items-center text-xs text-muted-foreground">
                  days
                </span>
              </div>
            </div>
            <div className="flex items-center justify-between gap-3 py-2.5">
              <Label htmlFor="trial-minutes" className="text-sm font-medium">
                Call minutes
              </Label>
              <div className="relative">
                <Input
                  id="trial-minutes"
                  type="number"
                  min={1}
                  value={trialMinutesDraft}
                  onChange={(e) => setTrialMinutesDraft(e.target.value)}
                  className="w-28 pr-10 text-right"
                />
                <span className="pointer-events-none absolute inset-y-0 right-3 flex items-center text-xs text-muted-foreground">
                  min
                </span>
              </div>
            </div>
          </div>

          <div className="flex items-center justify-end border-t border-border/60 bg-muted/30 px-4 py-2.5">
            <Button size="sm" onClick={saveTrial} disabled={savingTrial || !trialDirty}>
              {savingTrial && <Loader2 className="size-4 animate-spin" />}
              Save
            </Button>
          </div>
        </Card>

        {/* Post-trial grace period */}
        <Card className="flex flex-col overflow-hidden p-0 shadow-none">
          <div className="flex flex-col gap-2.5 border-b border-border/60 px-4 py-3 sm:flex-row sm:items-start sm:gap-3">
            <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-primary-tint text-primary">
              <LifeBuoy className="size-4" />
            </span>
            <div>
              <h3 className="text-sm font-semibold leading-tight">Post-trial grace period</h3>
              <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
                When a free trial ends without a plan, hold the customer's number for this many days
                before releasing it back to the pool. They're emailed when grace starts, again near
                the end, and 24 hours before release.
              </p>
            </div>
          </div>

          <div className="flex-1 divide-y divide-border/60 px-4">
            <div className="flex items-center justify-between gap-3 py-2.5">
              <Label htmlFor="grace-enabled" className="text-sm font-medium">
                Enabled
              </Label>
              <Switch id="grace-enabled" checked={graceEnabled} onCheckedChange={setGraceEnabled} />
            </div>
            <div className="flex items-center justify-between gap-3 py-2.5">
              <Label htmlFor="grace-days" className="text-sm font-medium">
                Grace length
              </Label>
              <div className="relative">
                <Input
                  id="grace-days"
                  type="number"
                  min={1}
                  max={90}
                  value={graceDaysDraft}
                  onChange={(e) => setGraceDaysDraft(e.target.value)}
                  disabled={!graceEnabled}
                  className="w-28 pr-12 text-right"
                />
                <span className="pointer-events-none absolute inset-y-0 right-3 flex items-center text-xs text-muted-foreground">
                  days
                </span>
              </div>
            </div>
          </div>

          <div className="flex items-center justify-end border-t border-border/60 bg-muted/30 px-4 py-2.5">
            <Button size="sm" onClick={saveGrace} disabled={savingGrace || !graceDirty}>
              {savingGrace && <Loader2 className="size-4 animate-spin" />}
              Save
            </Button>
          </div>
        </Card>

        {/* Per-call duration ceiling — abuse control, not a plan feature */}
        <Card className="flex flex-col overflow-hidden p-0 shadow-none">
          <div className="flex flex-col gap-2.5 border-b border-border/60 px-4 py-3 sm:flex-row sm:items-start sm:gap-3">
            <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-primary-tint text-primary">
              <Timer className="size-4" />
            </span>
            <div>
              <h3 className="text-sm font-semibold leading-tight">Maximum call length</h3>
              <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
                No single call may run longer than this, on any plan — so one caller can't drain a
                customer's whole month of minutes in one sitting. The assistant wraps up 30 seconds
                before the limit, and saving applies it to every live agent straight away.
              </p>
            </div>
          </div>

          <div className="flex-1 divide-y divide-border/60 px-4">
            <div className="flex items-center justify-between gap-3 py-2.5">
              <Label htmlFor="cap-enabled" className="text-sm font-medium">
                Enabled
              </Label>
              <Switch id="cap-enabled" checked={capEnabled} onCheckedChange={setCapEnabled} />
            </div>
            <div className="flex items-center justify-between gap-3 py-2.5">
              <Label htmlFor="cap-minutes" className="text-sm font-medium">
                Call limit
              </Label>
              <div className="relative">
                <Input
                  id="cap-minutes"
                  type="number"
                  min={1}
                  max={60}
                  value={capMinutesDraft}
                  onChange={(e) => setCapMinutesDraft(e.target.value)}
                  disabled={!capEnabled}
                  className="w-28 pr-10 text-right"
                />
                <span className="pointer-events-none absolute inset-y-0 right-3 flex items-center text-xs text-muted-foreground">
                  min
                </span>
              </div>
            </div>
          </div>

          <div className="flex items-center justify-end border-t border-border/60 bg-muted/30 px-4 py-2.5">
            <Button size="sm" onClick={saveCallCap} disabled={savingCap || !capDirty}>
              {savingCap && <Loader2 className="size-4 animate-spin" />}
              Save
            </Button>
          </div>
        </Card>
        </div>
        )}
      </div>
      )}

      {plans === null ? (
        <div className="grid grid-cols-1 gap-6 md:grid-cols-2 lg:grid-cols-3">
          {Array.from({ length: 3 }).map((_, i) => (
            <CardSkeleton key={i} rows={5} />
          ))}
        </div>
      ) : plans.length === 0 ? (
        <Card className="flex flex-col items-center gap-2 py-16 text-center">
          <Package className="size-8 text-muted-foreground" />
          <p className="text-sm font-medium">No plans yet</p>
          <p className="text-sm text-muted-foreground">Create your first plan to get started.</p>
          {canCreate && (
            <Button className="mt-2" onClick={openCreate}>
              <Plus className="size-4" /> New plan
            </Button>
          )}
        </Card>
      ) : (
        <div className="grid grid-cols-1 gap-6 md:grid-cols-2 lg:grid-cols-3">
          {plans.map((plan) => (
            <Card key={plan.id} className={cn("flex flex-col p-6", !plan.active && "opacity-60")}>
              <div className="flex items-start justify-between gap-3">
                <div className="flex items-center gap-2">
                  <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-primary-tint text-primary">
                    <Package className="size-5" />
                  </span>
                  <div>
                    <h3 className="text-base font-semibold leading-tight">{plan.displayName}</h3>
                    <p className="text-xs text-muted-foreground">{plan.name}</p>
                  </div>
                </div>
                <div className="flex items-center gap-1.5">
                  {plan.isDefault && <Badge variant="success">Default</Badge>}
                  {plan.stripePriceId ? (
                    <Badge variant="premium">Stripe</Badge>
                  ) : (
                    <Badge variant="neutral">No Stripe</Badge>
                  )}
                  {plan.legacy ? (
                    <Badge variant="warning">Legacy</Badge>
                  ) : (
                    !plan.active && <Badge variant="neutral">Inactive</Badge>
                  )}
                </div>
              </div>
              {typeof plan.subscriberCount === "number" && plan.subscriberCount > 0 && (
                <p className="mt-2 text-xs text-muted-foreground">
                  {plan.subscriberCount} active subscriber{plan.subscriberCount === 1 ? "" : "s"} — pricing locked
                </p>
              )}

              <div className="mt-4 flex items-baseline gap-1">
                <span className="text-2xl font-semibold tracking-tight">
                  {formatPrice(plan.priceCents, plan.currency, plan.interval, plan.intervalCount)}
                </span>
              </div>
              {plan.description && (
                <p className="mt-1 text-sm text-muted-foreground">{plan.description}</p>
              )}

              <div className="mt-3 flex flex-wrap items-center gap-2">
                {/* Free-trial length applies to every plan (global setting) — lead with
                    it so it's the first thing seen. Uses the admin-configured days. */}
                {trialDays != null && trialDays > 0 && (
                  <span className="inline-flex items-center gap-1.5 rounded-full bg-success-tint px-2.5 py-1 text-xs font-semibold text-success">
                    <Clock className="size-3.5" />
                    {trialDays}-day free trial
                  </span>
                )}
                <span className="inline-flex items-center gap-1.5 rounded-full bg-primary-tint px-2.5 py-1 text-xs font-semibold text-primary">
                  <PhoneCall className="size-3.5" />
                  {plan.includedMinutes > 0 ? `${plan.includedMinutes.toLocaleString()} min` : "Unlimited"} /{" "}
                  {intervalLabel(plan.interval, plan.intervalCount)}
                </span>
                {plan.smsEnabled && (
                  <span className="inline-flex items-center gap-1.5 rounded-full bg-muted px-2.5 py-1 text-xs font-medium text-foreground">
                    <MessageSquare className="size-3.5" /> SMS
                  </span>
                )}
                {plan.whatsappEnabled && (
                  <span className="inline-flex items-center gap-1.5 rounded-full bg-muted px-2.5 py-1 text-xs font-medium text-foreground">
                    <MessageCircle className="size-3.5" /> WhatsApp
                  </span>
                )}
                {plan.customCrmEnabled && (
                  <span className="inline-flex items-center gap-1.5 rounded-full bg-muted px-2.5 py-1 text-xs font-medium text-foreground">
                    <Link2 className="size-3.5" /> Custom CRM
                  </span>
                )}
                {plan.multilingualEnabled && (
                  <span className="inline-flex items-center gap-1.5 rounded-full bg-muted px-2.5 py-1 text-xs font-medium text-foreground">
                    <Globe className="size-3.5" /> Multilingual
                  </span>
                )}
                {plan.voiceCategoryId && (
                  <span className="inline-flex items-center gap-1.5 rounded-full bg-muted px-2.5 py-1 text-xs font-medium text-foreground">
                    <Mic className="size-3.5" />{" "}
                    {categories.find((c) => c.id === plan.voiceCategoryId)?.title ?? "Voices"}
                  </span>
                )}
                {plan.recommended && (
                  <Badge variant="premium">Popular</Badge>
                )}
              </div>

              {/* Admin-only minutes row on top, then the shared canonical feature order
                  (buildPlanFeatureRows) so this preview matches the customer plan cards. */}
              <ul className="mt-4 flex flex-1 flex-col gap-2">
                {[
                  {
                    label: `${plan.includedMinutes > 0 ? `${plan.includedMinutes.toLocaleString()} call minutes` : "Unlimited call minutes"} each month`,
                    included: true,
                  },
                  ...buildPlanFeatureRows(plan, {
                    voiceCategoryName: categories.find((c) => c.id === plan.voiceCategoryId)?.title ?? null,
                  }),
                ]
                  .map((f) => (
                    <li key={f.label} className="flex items-start gap-2 text-sm">
                      {f.included ? (
                        <Check className="mt-0.5 size-4 shrink-0 text-success" />
                      ) : (
                        <X className="mt-0.5 size-4 shrink-0 text-muted-foreground/60" />
                      )}
                      <span className={cn(!f.included && "text-muted-foreground/70 line-through")}>
                        {f.label}
                      </span>
                    </li>
                  ))}
              </ul>

              {(canEdit || canDelete) && (
                <div className="mt-6 flex gap-2 border-t border-border pt-4">
                  {canEdit && (
                    <Button variant="outline" size="sm" className="flex-1" onClick={() => openEdit(plan)}>
                      <Pencil className="size-4" /> Edit
                    </Button>
                  )}
                  {canDelete && (
                    <Button
                      variant="ghost"
                      size="sm"
                      className="text-danger hover:bg-danger-tint hover:text-danger"
                      onClick={() => setToDelete(plan)}
                      aria-label={`Delete ${plan.displayName}`}
                    >
                      <Trash2 className="size-4" />
                    </Button>
                  )}
                </div>
              )}
            </Card>
          ))}
        </div>
      )}

      {/* Create / edit dialog */}
      <Dialog
        open={dialogOpen}
        onOpenChange={(o) => {
          if (saving) return;
          setDialogOpen(o);
        }}
      >
        <DialogContent className="flex max-h-[90vh] w-[calc(100vw-2rem)] max-w-2xl flex-col gap-0 p-0">
          <DialogHeader className="border-b border-border px-6 pb-4 pt-6">
            <DialogTitle>{editing ? "Edit plan" : "New plan"}</DialogTitle>
            <DialogDescription>
              {editing ? "Update this plan's details." : "Define a plan customers can subscribe to."}
            </DialogDescription>
          </DialogHeader>

          <div className="min-h-0 flex-1 space-y-8 overflow-y-auto px-6 py-6">
            {/* Plan basics */}
            <section className="space-y-5">
              <SectionHeading icon={<Package className="size-3.5" />}>Plan basics</SectionHeading>
              <div className="grid gap-x-5 gap-y-5 sm:grid-cols-2">
                <Field label="Key" htmlFor="pl-name" hint="Internal id — lowercase, no spaces.">
                  <Input
                    id="pl-name"
                    placeholder="starter"
                    value={form.name}
                    onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                  />
                </Field>
                <Field
                  label="Display name"
                  htmlFor="pl-display"
                  hint="Shown to customers on the subscribe page."
                >
                  <Input
                    id="pl-display"
                    placeholder="Starter"
                    value={form.displayName}
                    onChange={(e) => setForm((f) => ({ ...f, displayName: e.target.value }))}
                  />
                </Field>
              </div>
              <Field label="Description" htmlFor="pl-desc">
                <Input
                  id="pl-desc"
                  placeholder="Short one-line summary"
                  value={form.description}
                  onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
                />
              </Field>
            </section>

            {/* Pricing & usage */}
            <section className="space-y-5">
              <SectionHeading icon={<DollarSign className="size-3.5" />}>Pricing &amp; usage</SectionHeading>
              {!!editing && (editing.subscriberCount ?? 0) > 0 && (
                <div className="flex items-start gap-2 rounded-xl border border-warning/40 bg-warning-tint px-3.5 py-2.5 text-xs text-foreground">
                  <Lock className="mt-0.5 size-3.5 shrink-0 text-warning" />
                  <span>
                    This plan has {editing.subscriberCount} active subscriber
                    {editing.subscriberCount === 1 ? "" : "s"}. Price, interval and minutes are locked.
                    To change pricing, deactivate it (it becomes a legacy plan) and create a new plan.
                  </span>
                </div>
              )}
              <div className="grid gap-x-5 gap-y-5 sm:grid-cols-3">
                <Field label={`Price (${form.currency.toUpperCase()})`} htmlFor="pl-price">
                  <div className="relative">
                    <span className="pointer-events-none absolute inset-y-0 left-3.5 flex items-center text-sm text-muted-foreground">
                      $
                    </span>
                    <Input
                      id="pl-price"
                      type="number"
                      min={0}
                      step="0.01"
                      placeholder="49"
                      value={form.price}
                      disabled={!!editing && (editing.subscriberCount ?? 0) > 0}
                      onChange={(e) => setForm((f) => ({ ...f, price: e.target.value }))}
                      className="pl-7"
                    />
                  </div>
                </Field>
                <Field label="Currency" htmlFor="pl-currency">
                  <Select
                    value={form.currency}
                    onValueChange={(v) => setForm((f) => ({ ...f, currency: v }))}
                    disabled={!!editing && (editing.subscriberCount ?? 0) > 0}
                  >
                    <SelectTrigger id="pl-currency">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {CURRENCIES.map((c) => (
                        <SelectItem key={c} value={c}>
                          {c.toUpperCase()}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </Field>
                <Field label="Billing interval" htmlFor="pl-interval">
                  <Select
                    value={String(form.intervalCount)}
                    onValueChange={(v) => setForm((f) => ({ ...f, intervalCount: Number(v) }))}
                    disabled={!!editing && (editing.subscriberCount ?? 0) > 0}
                  >
                    <SelectTrigger id="pl-interval">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {INTERVAL_COUNTS.map((c) => (
                        <SelectItem key={c} value={String(c)}>
                          {intervalOptionLabel(c)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </Field>
              </div>
              <div className="grid gap-x-5 gap-y-5 sm:grid-cols-2">
                <Field
                  label="Included minutes"
                  htmlFor="pl-minutes"
                  hint="Granted each billing period after the trial converts."
                >
                  <div className="relative">
                    <Input
                      id="pl-minutes"
                      type="number"
                      min={0}
                      step="1"
                      placeholder="200"
                      value={form.includedMinutes}
                      disabled={!!editing && (editing.subscriberCount ?? 0) > 0}
                      onChange={(e) => setForm((f) => ({ ...f, includedMinutes: e.target.value }))}
                      className="pr-12"
                    />
                    <span className="pointer-events-none absolute inset-y-0 right-3.5 flex items-center text-xs text-muted-foreground">
                      min
                    </span>
                  </div>
                </Field>
                <Field label="Sort order" htmlFor="pl-sort" hint="0, 1, 2… — lower is shown first on the subscribe page.">
                  <Input
                    id="pl-sort"
                    type="number"
                    min={0}
                    step={1}
                    value={form.sortOrder}
                    // Strip any negative / non-digit input so only 0,1,2… can be entered.
                    onChange={(e) =>
                      setForm((f) => ({ ...f, sortOrder: e.target.value.replace(/[^0-9]/g, "") }))
                    }
                  />
                </Field>
              </div>
            </section>

            {/* Voice & capabilities */}
            <section className="space-y-5">
              <SectionHeading icon={<SlidersHorizontal className="size-3.5" />}>
                Voice &amp; capabilities
              </SectionHeading>
              {/* Voice category this plan unlocks — customers pick any voice in it from their AI Brain. */}
              <Field
                label={
                  <span className="flex items-center gap-1.5">
                    <Mic className="size-3.5 text-primary" /> Voice category
                  </span>
                }
                htmlFor="pl-voice-category"
                hint={
                  <>
                    Leave as “None” to keep the default voice. Manage categories in{" "}
                    <span className="font-medium">Admin → Voice Library</span>.
                    {categories.length === 0 && " No categories yet — create one there first."}
                  </>
                }
              >
                <select
                  id="pl-voice-category"
                  value={form.voiceCategoryId}
                  onChange={(e) => setForm((f) => ({ ...f, voiceCategoryId: e.target.value }))}
                  className="h-10 w-full rounded-xl border border-border bg-background px-3.5 text-sm focus-visible:focus-ring"
                >
                  <option value="">None (default voice only)</option>
                  {categories.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.title} ({c.voiceIds.length} voice{c.voiceIds.length === 1 ? "" : "s"})
                    </option>
                  ))}
                </select>
              </Field>

              <div className="grid gap-3 sm:grid-cols-2">
                <ToggleCard
                  title="SMS Summaries"
                  desc="Post-call owner text summaries."
                  checked={form.smsEnabled}
                  onChange={(v) => setForm((f) => ({ ...f, smsEnabled: v }))}
                />
                <ToggleCard
                  title="SMS to Caller"
                  desc="AI texts callers details they ask for mid-call."
                  checked={form.smsToCallerEnabled}
                  onChange={(v) => setForm((f) => ({ ...f, smsToCallerEnabled: v }))}
                />
                <ToggleCard
                  title="WhatsApp"
                  desc="Summaries + inbound AI auto-reply."
                  checked={form.whatsappEnabled}
                  onChange={(v) => setForm((f) => ({ ...f, whatsappEnabled: v }))}
                />
                <ToggleCard
                  title="Custom CRM Integration"
                  desc="Deliver leads to any platform via webhook."
                  checked={form.customCrmEnabled}
                  onChange={(v) => setForm((f) => ({ ...f, customCrmEnabled: v }))}
                />
                <ToggleCard
                  title="Multilingual Answering"
                  desc="Customers pick their assistant's languages in the AI Brain."
                  checked={form.multilingualEnabled}
                  onChange={(v) => setForm((f) => ({ ...f, multilingualEnabled: v }))}
                />
                <ToggleCard
                  title="Summary, Transcript & Recording"
                  desc="Show the transcripts & recordings bullet on this plan."
                  checked={form.transcriptsEnabled}
                  onChange={(v) => setForm((f) => ({ ...f, transcriptsEnabled: v }))}
                />
                <ToggleCard
                  title="Call Transfer"
                  desc="Hand callers to a human department mid-call."
                  checked={form.callTransferEnabled}
                  onChange={(v) => setForm((f) => ({ ...f, callTransferEnabled: v }))}
                />
                <ToggleCard
                  title="Active"
                  desc="Inactive plans aren't shown to customers."
                  checked={form.active}
                  // An inactive plan can't be the default (subscribe only lists active
                  // plans) — turning Active off clears Default too.
                  onChange={(v) => setForm((f) => ({ ...f, active: v, isDefault: v ? f.isDefault : false }))}
                />
                <ToggleCard
                  title="Recommended"
                  desc="Highlighted as “Popular” on subscribe."
                  checked={form.recommended}
                  onChange={(v) => setForm((f) => ({ ...f, recommended: v }))}
                />
                <ToggleCard
                  title="Default plan"
                  desc={
                    form.active
                      ? "Pre-selected on the onboarding subscribe page."
                      : "Activate this plan to make it the default."
                  }
                  checked={form.isDefault}
                  disabled={!form.active}
                  onChange={(v) => setForm((f) => ({ ...f, isDefault: v }))}
                />
              </div>

              {/* Only meaningful while Call Transfer is on, so it stays hidden
                  otherwise rather than sitting there greyed out asking to be
                  read. 0 = unlimited, matching Included Minutes above. */}
              {form.callTransferEnabled && (
                <Field
                  label="Transfer departments"
                  htmlFor="pl-transfer-limit"
                  hint="How many departments this plan may configure. 0 = unlimited."
                >
                  <div className="relative">
                    <Input
                      id="pl-transfer-limit"
                      type="number"
                      min={0}
                      step="1"
                      placeholder="3"
                      value={form.callTransferLimit}
                      onChange={(e) => setForm((f) => ({ ...f, callTransferLimit: e.target.value }))}
                      className="pr-28"
                    />
                    <span className="pointer-events-none absolute inset-y-0 right-3.5 flex items-center text-xs text-muted-foreground">
                      {Number(form.callTransferLimit) > 0 ? "departments" : "unlimited"}
                    </span>
                  </div>
                </Field>
              )}
            </section>
          </div>

          <DialogFooter className="border-t border-border px-6 py-4">
            <Button variant="outline" onClick={() => setDialogOpen(false)} disabled={saving}>
              Cancel
            </Button>
            <Button onClick={submit} disabled={saving}>
              {saving && <Loader2 className="size-4 animate-spin" />}
              {editing ? "Save changes" : "Create plan"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete confirm */}
      <ConfirmDeleteDialog
        open={toDelete !== null}
        onOpenChange={(o) => !o && setToDelete(null)}
        resourceType="plan"
        resourceName={toDelete?.displayName ?? ""}
        onConfirm={confirmDelete}
        description="Customers already on it keep their subscription; it just can't be chosen anymore."
      />
    </div>
  );
}

/** Small uppercase section label (with icon) used to group the plan form fields. */
function SectionHeading({ icon, children }: { icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-2.5">
      <span className="grid size-6 shrink-0 place-items-center rounded-md bg-primary-tint text-primary">
        {icon}
      </span>
      <h3 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
        {children}
      </h3>
      <span className="h-px flex-1 bg-border" />
    </div>
  );
}

/** A labelled form field: label → control → optional hint, with consistent spacing. */
function Field({
  label,
  htmlFor,
  hint,
  children,
}: {
  label: React.ReactNode;
  htmlFor?: string;
  hint?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div>
      <Label htmlFor={htmlFor} className="mb-2 block leading-snug">
        {label}
      </Label>
      {children}
      {hint && <p className="mt-2 text-xs leading-relaxed text-muted-foreground">{hint}</p>}
    </div>
  );
}

/** A bordered on/off row used for plan capability toggles; highlights when enabled. */
function ToggleCard({
  title,
  desc,
  checked,
  onChange,
  disabled,
}: {
  title: string;
  desc: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <div
      className={cn(
        "flex items-center justify-between gap-3 rounded-xl border px-3.5 py-3 transition-colors",
        checked ? "border-primary/40 bg-primary-tint-soft" : "border-border",
        disabled && "opacity-60",
      )}
    >
      <div className="min-w-0">
        <p className="text-sm font-medium">{title}</p>
        <p className="text-xs text-muted-foreground">{desc}</p>
      </div>
      <Switch checked={checked} onCheckedChange={onChange} disabled={disabled} />
    </div>
  );
}
