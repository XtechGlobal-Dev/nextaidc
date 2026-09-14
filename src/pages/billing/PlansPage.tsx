import { useCallback, useEffect, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import {
  AlertTriangle,
  ArrowDownCircle,
  ArrowRight,
  ArrowLeftRight,
  ArrowUpCircle,
  Check,
  Clock,
  CreditCard,
  Gift,
  Globe,
  Link2,
  Loader2,
  MessageCircle,
  MessageSquare,
  RefreshCw,
  ShieldCheck,
  Sparkles,
  Ticket,
  X,
} from "lucide-react";
import { toast } from "sonner";
import { PageHeader } from "@/components/layout/PageHeader";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { ProgressBar } from "@/components/ui/misc";
import { PageSkeleton } from "@/components/ui/skeleton";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  api,
  ApiError,
  type PlanChangePreview,
  type SubscriptionDetail,
  type SubscriptionPlan,
} from "@/lib/api";
import { CurrencySwitchForm } from "@/components/billing/CurrencySwitchForm";
import { useStripePortal } from "@/hooks/useStripePortal";
import { useTrialStore } from "@/stores/useTrialStore";
import { formatMoney } from "@/lib/currency";
import { intervalLabel } from "@/lib/billingInterval";
import { buildPlanFeatureRows, clearCachedEntitlements } from "@/lib/planFeatures";
import { cn, formatDateDMY } from "@/lib/utils";

function fmtDate(iso: string | null): string {
  return formatDateDMY(iso);
}

export default function PlansPage() {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const trial = useTrialStore((s) => s.trial);
  const hydrateTrial = useTrialStore((s) => s.hydrate);
  const [loading, setLoading] = useState(true);
  const [plans, setPlans] = useState<SubscriptionPlan[]>([]);
  const [sub, setSub] = useState<SubscriptionDetail | null>(null);

  // Amounts are stored/billed in each plan's own currency; default to the
  // user's current subscription currency when none is passed.
  const money = (cents: number, currency?: string | null) =>
    formatMoney(cents, currency ?? sub?.currency);

  const [changeTarget, setChangeTarget] = useState<SubscriptionPlan | null>(null);
  // Cross-currency switch is its own flow: a NEW subscription on a NEW Stripe customer with a re-entered card, not a price swap.
  const [switchTarget, setSwitchTarget] = useState<SubscriptionPlan | null>(null);
  const [switchSecret, setSwitchSecret] = useState<string | null>(null);
  const [switchStarting, setSwitchStarting] = useState(false);
  const [preview, setPreview] = useState<PlanChangePreview | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [togglingRenew, setTogglingRenew] = useState(false);
  const [renewing, setRenewing] = useState(false);
  // Confirm before turning auto-renew OFF (it freezes calls at period end).
  const [confirmDisableRenew, setConfirmDisableRenew] = useState(false);
  // Confirm before renewing (it charges the saved card now).
  const [confirmRenew, setConfirmRenew] = useState(false);
  // Open when the user clicks an already-scheduled plan — manage (keep / let it proceed).
  const [manageScheduled, setManageScheduled] = useState(false);
  // `portalBusy` disables both portal buttons so a slow network doesn't look
  // dead or invite double-clicks.
  const { open: openPortal, busy: portalBusy } = useStripePortal();

  const reload = useCallback(async () => {
    const [planList, subRes] = await Promise.all([
      api.billing.plans().catch(() => [] as SubscriptionPlan[]),
      api.billing.subscription().catch(() => ({ subscription: null })),
    ]);
    setPlans(planList);
    setSub(subRes.subscription);
    // Entitlements apply the moment a change lands — drop the cache so gated screens don't show the old answer.
    clearCachedEntitlements();
    void hydrateTrial();
  }, [hydrateTrial]);

  useEffect(() => {
    void reload().finally(() => setLoading(false));
  }, [reload]);

  // Poll + refresh on focus: a real call records usage server-side with no client event to push it.
  useEffect(() => {
    const id = window.setInterval(() => void reload(), 15_000);
    const onFocus = () => void reload();
    window.addEventListener("focus", onFocus);
    return () => {
      window.clearInterval(id);
      window.removeEventListener("focus", onFocus);
    };
  }, [reload]);

  // Opened via a "Renew plan" CTA (?renew=1) from the global banner / sidebar →
  // pop the renew confirmation. Clear the flag so a refresh doesn't reopen it.
  useEffect(() => {
    if (searchParams.get("renew") !== "1") return;
    setConfirmRenew(true);
    const next = new URLSearchParams(searchParams);
    next.delete("renew");
    setSearchParams(next, { replace: true });
  }, [searchParams, setSearchParams]);

  // A canceled subscription is frozen — route the user back to the subscribe flow
  // to pick a plan again (same as having none).
  const hasSubscription = !!sub && sub.status !== "none" && sub.status !== "canceled";
  const currentPlanId = sub?.planId ?? null;

  async function openChange(plan: SubscriptionPlan) {
    setChangeTarget(plan);
    setPreview(null);
    setPreviewing(true);
    try {
      setPreview(await api.billing.changePlanPreview(plan.id));
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "Couldn't load the change preview");
      setChangeTarget(null);
    } finally {
      setPreviewing(false);
    }
  }

  // Reserves the new (unpaid) subscription. Nothing is charged and the current plan is untouched — closing the dialog is a no-op.
  async function openSwitch(plan: SubscriptionPlan) {
    setSwitchTarget(plan);
    setSwitchSecret(null);
    setSwitchStarting(true);
    try {
      const res = await api.billing.switchCurrencyStart(plan.id);
      setSwitchSecret(res.clientSecret);
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "Couldn't start the plan switch");
      setSwitchTarget(null);
    } finally {
      setSwitchStarting(false);
    }
  }

  /** Close the dialog and release the unpaid subscription we opened. Best-effort:
   *  Stripe expires it on its own, so a failed tidy-up is not worth blocking on. */
  async function closeSwitch() {
    setSwitchTarget(null);
    setSwitchSecret(null);
    await api.billing.switchCurrencyCancel().catch(() => {});
  }

  async function confirmChange() {
    if (!changeTarget) return;
    setConfirming(true);
    try {
      const res = await api.billing.changePlan(changeTarget.id);
      toast.success(res.message, { duration: 7000 });
      setChangeTarget(null);
      setPreview(null);
      await reload();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "Plan change failed");
    } finally {
      setConfirming(false);
    }
  }

  async function cancelDowngrade() {
    setCancelling(true);
    try {
      const res = await api.billing.cancelDowngrade();
      toast.success(res.message);
      setManageScheduled(false);
      await reload();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "Couldn't cancel the downgrade");
    } finally {
      setCancelling(false);
    }
  }

  async function toggleAutoRenew(enabled: boolean) {
    setTogglingRenew(true);
    setSub((s) => (s ? { ...s, autoRenew: enabled } : s)); // optimistic
    try {
      const res = await api.billing.setAutoRenew(enabled);
      toast.success(res.message, { duration: 6000 });
      await reload();
    } catch (e) {
      setSub((s) => (s ? { ...s, autoRenew: !enabled } : s)); // revert
      toast.error(e instanceof ApiError ? e.message : "Couldn't update auto-renew");
    } finally {
      setTogglingRenew(false);
    }
  }

  async function renewPlan() {
    setRenewing(true);
    try {
      const res = await api.billing.renew();
      toast.success(res.message, { duration: 7000 });
      setConfirmRenew(false);
      await reload();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "Couldn't renew your plan");
    } finally {
      setRenewing(false);
    }
  }

  if (loading) {
    return <PageSkeleton variant="cards" stats={3} />;
  }

  // No subscription yet → send them to the subscribe flow.
  if (!hasSubscription) {
    return (
      <div>
        <PageHeader title="Plans & Billing" subtitle="Choose a plan to start handling calls." className="mb-4" />
        <Card>
          <CardContent className="flex flex-col items-center gap-4 py-12 text-center">
            <Sparkles className="size-10 text-primary" />
            <p className="text-muted-foreground">You're not subscribed to a plan yet.</p>
            <Button onClick={() => navigate("/subscribe")}>Choose a plan</Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  const usedPct =
    trial && trial.minutesAllocated > 0 ? Math.min(100, (trial.minutesUsed / trial.minutesAllocated) * 100) : 0;
  const isTrial = sub?.status === "trialing";
  const isPastDue = sub?.status === "past_due";
  const scheduled = sub?.scheduledPlan ?? null;
  // The trial's total length as configured by the admin (e.g. "14 days") — the
  // allowance the user gets, NOT a live countdown. Pairs with minutesAllocated.
  const trialTotalDays = isTrial && trial?.trialDays ? trial.trialDays : null;
  // Minutes the user actually has on the current plan/trial (for auto-renew copy).
  const planMinutes = trial && !trial.unlimited ? trial.minutesAllocated : (sub?.includedMinutes ?? 0);
  // The current plan (for the renew-confirm modal's feature list / marketing bullets).
  const currentRenewPlan = plans.find((p) => p.id === currentPlanId) ?? null;

  // What does clicking this plan's button do, given the current subscription?
  function planRelation(plan: SubscriptionPlan) {
    const isCurrent = plan.id === currentPlanId;
    const isScheduledTarget = !isTrial && scheduled?.id === plan.id;
    // Stripe fixes a subscription's currency at creation, so another-currency plan can't be swapped to
    // (the server refused after preview + confirm). Price comparison is meaningless across currencies too.
    const otherCurrency =
      !!sub?.currency && !!plan.currency && plan.currency !== sub.currency;
    const cmp = plan.priceCents - (sub?.priceCents ?? 0);
    const direction = cmp > 0 ? "upgrade" : cmp < 0 ? "downgrade" : "same";
    return { isCurrent, isScheduledTarget, direction, otherCurrency };
  }

  // Direction for the open change-plan modal — derived from price so the title and
  // button read correctly immediately, before the async charge preview resolves.
  const changeIsDowngrade = !!changeTarget && planRelation(changeTarget).direction === "downgrade";

  return (
    <div className="space-y-5">
      <PageHeader
        title="Plans & Billing"
        subtitle="Manage your plan and minutes."
        className="mb-1"
      />

      {/* One concise "how it works" banner — adapts to trial vs. active so the
          two states don't stack three overlapping explanations. */}
      <div className="flex items-start gap-3 rounded-[var(--radius-card)] border border-primary/30 bg-primary-tint p-4 text-sm">
        <span className="mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-xl bg-primary text-primary-foreground">
          {isTrial ? <Gift className="size-5" /> : <RefreshCw className="size-5" />}
        </span>
        <div className="min-w-0">
          {isTrial ? (
            <>
              <p className="font-normal text-foreground">
                <b>Free trial active</b> —{" "}
                <mark className="rounded bg-primary/15 px-1.5 py-0.5 font-semibold text-primary">
                  {trial && !trial.unlimited ? `${trial.minutesAllocated} minutes` : "unlimited minutes"}
                </mark>{" "}
                included, valid until <b>{fmtDate(sub?.trialEndsAt ?? null)}</b>.
              </p>
              <p className="mt-1 text-foreground">
                When your trial minutes run out <em>or</em> the days are up{" "}
                <span className="font-semibold text-primary">(whichever comes first)</span>,{" "}
                <strong className="text-foreground">{sub?.planName}</strong> starts automatically at{" "}
                <mark className="rounded bg-primary/15 px-1.5 py-0.5 font-semibold text-primary">{money(sub?.priceCents ?? 0)}/{intervalLabel(sub?.interval, sub?.intervalCount)}</mark>.
                Switch plans anytime before then — no charge today.
              </p>
            </>
          ) : (
            <>
              <p className="font-semibold text-foreground">
                Renews automatically on{" "}
                <span className="text-primary">whichever limit comes first</span>
              </p>
              <p className="mt-1 text-muted-foreground">
                When your <strong className="text-foreground">included minutes</strong> run out <em>or</em> you reach your{" "}
                <strong className="text-foreground">renewal date</strong>, your plan renews, minutes reset, and we charge
                your saved card — so your AI never stops answering.
              </p>
            </>
          )}
        </div>
      </div>

      {/* Past-due banner */}
      {isPastDue && (
        <div className="flex flex-wrap items-center gap-2 rounded-[var(--radius-card)] border border-danger/40 bg-danger/5 px-4 py-3 text-sm">
          <AlertTriangle className="size-4 shrink-0 text-danger" />
          <span>
            <strong>Payment past due.</strong> We couldn't charge your card, so calls are paused. Update your
            payment method to restore service.
          </span>
          <Button
            size="sm"
            variant="outline"
            className="ml-auto"
            onClick={openPortal}
            disabled={portalBusy}
          >
            {portalBusy ? "Opening…" : "Update payment"}
          </Button>
        </div>
      )}

      {/* Pending downgrade banner */}
      {scheduled && (
        <div className="flex flex-wrap items-center gap-2 rounded-[var(--radius-card)] border border-warning/40 bg-warning-tint px-4 py-3 text-sm">
          <Clock className="size-4 shrink-0 text-warning" />
          <span>
            <strong>Downgrade scheduled.</strong> You'll keep <strong>{sub?.planName}</strong> until{" "}
            <strong>{fmtDate(scheduled.effectiveAt)}</strong>, then move to{" "}
            <strong>{scheduled.name}</strong>. No charge today.
          </span>
          <Button size="sm" variant="outline" className="ml-auto" onClick={cancelDowngrade} disabled={cancelling}>
            {cancelling && <Loader2 className="size-4 animate-spin" />}
            Keep my plan
          </Button>
        </div>
      )}

      {/* Current plan + usage */}
      <Card>
        <CardHeader>
          <CardTitle className="flex flex-wrap items-center gap-2">
            <CreditCard className="size-5 text-primary" />
            Current plan: {sub?.planName ?? "—"}
            {isTrial && <Badge variant="primary">Free Trial</Badge>}
            {sub?.legacy && <Badge variant="warning">Legacy</Badge>}
            {!isTrial && !sub?.legacy && sub?.status === "active" && <Badge variant="success">Active</Badge>}
            {sub?.status === "past_due" && <Badge variant="danger">Past due</Badge>}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {/* Key facts as a tidy stat grid — separates the trial allowance from the
              full plan's minutes so the two numbers never read as a contradiction. */}
          <div className="grid grid-cols-1 gap-px overflow-hidden rounded-lg border border-border bg-border text-sm sm:grid-cols-3">
            <div className="bg-card px-3 py-2.5">
              <p className="text-xs text-muted-foreground">Plan price</p>
              <p className="mt-0.5 font-semibold text-foreground">
                {money(sub?.priceCents ?? 0)}
                <span className="font-normal text-muted-foreground">/{intervalLabel(sub?.interval, sub?.intervalCount)}</span>
              </p>
            </div>
            <div className="bg-card px-3 py-2.5">
              <p className="text-xs text-muted-foreground">{isTrial ? "After trial" : "Included"}</p>
              <p className="mt-0.5 font-semibold text-foreground">
                {sub?.includedMinutes
                  ? `${sub.includedMinutes.toLocaleString()} min/${intervalLabel(sub?.interval, sub?.intervalCount)}`
                  : "Unlimited"}
              </p>
            </div>
            <div className="bg-card px-3 py-2.5">
              <p className="text-xs text-muted-foreground">{isTrial ? "Trial ends" : "Renews"}</p>
              <p className="mt-0.5 font-semibold text-foreground">
                {isTrial
                  ? fmtDate(sub?.trialEndsAt ?? null)
                  : sub?.currentPeriodEnd
                    ? fmtDate(sub.currentPeriodEnd)
                    : "—"}
              </p>
            </div>
          </div>

          {/* Live coupon: show what's applied and how long it lasts so the return to full price isn't a surprise. */}
          {sub?.discount && (
            <div className="flex flex-wrap items-center gap-3 rounded-lg border border-success/30 bg-success-tint px-3 py-2.5">
              <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-success text-white">
                <Ticket className="size-4" />
              </span>
              <div className="min-w-0 flex-1">
                <p className="text-sm font-semibold text-foreground">
                  {sub.discount.displayName}{" "}
                  <span className="font-mono text-xs font-normal text-muted-foreground">
                    ({sub.discount.code})
                  </span>
                </p>
                <p className="text-xs text-muted-foreground">
                  {[
                    sub.discount.percentOff ? `${sub.discount.percentOff}% off` : null,
                    sub.discount.bonusMinutes ? `+${sub.discount.bonusMinutes} minutes` : null,
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                  {" — "}
                  {sub.discount.cyclesLeft > 0
                    ? `${sub.discount.cyclesLeft} of ${sub.discount.durationCycles} charge${sub.discount.durationCycles === 1 ? "" : "s"} left, then full price`
                    : "finished — your next charge is full price"}
                </p>
              </div>
            </div>
          )}

          {trial && !trial.unlimited && (
            <div className="space-y-1.5">
              <div className="flex items-center justify-between text-sm">
                <span className="font-medium">
                  {isTrial ? "Trial minutes" : "Minutes"}: {Math.round(trial.minutesUsed * 10) / 10} / {trial.minutesAllocated} used
                </span>
                <span
                  className={cn(
                    "font-semibold tabular-nums",
                    usedPct >= 90 ? "text-danger" : usedPct >= 70 ? "text-warning" : "text-success",
                  )}
                >
                  {Math.round(trial.minutesRemaining * 10) / 10} min left ({Math.round(100 - usedPct)}%)
                </span>
              </div>
              <ProgressBar value={usedPct} barClassName={usedPct >= 90 ? "bg-danger" : usedPct >= 70 ? "bg-warning" : "bg-primary"} />
              <p className="text-xs text-muted-foreground">
                {isTrial
                  ? "When these run out, your paid plan starts automatically."
                  : "When these run out, your plan renews early and your minutes reset."}
              </p>

              {trial?.canRenew ? (
                <div className="mt-2 flex flex-wrap items-center gap-2 rounded-lg border border-danger/40 bg-danger/5 px-3 py-2 text-sm">
                  <AlertTriangle className="size-4 shrink-0 text-danger" />
                  <span className="min-w-0">
                    Your plan minutes are used up and calls are paused. Renew now to charge your saved
                    card, reset your minutes, and bring your AI back online.
                  </span>
                  <Button
                    size="sm"
                    className="ml-auto"
                    onClick={() => setConfirmRenew(true)}
                    disabled={renewing}
                  >
                    <RefreshCw className="size-4" /> Renew plan
                  </Button>
                </div>
              ) : usedPct >= 70 && !sub?.autoRenew ? (
                <div className="mt-2 flex flex-wrap items-center gap-2 rounded-lg border border-warning/40 bg-warning-tint px-3 py-2 text-sm">
                  <AlertTriangle className="size-4 shrink-0 text-warning" />
                  <span className="min-w-0">
                    You've used {Math.round(usedPct)}% of your minutes — upgrade for more headroom.
                  </span>
                  <Button
                    size="sm"
                    className="ml-auto"
                    onClick={() =>
                      document.getElementById("plan-options")?.scrollIntoView({ behavior: "smooth" })
                    }
                  >
                    <ArrowUpCircle className="size-4" /> Upgrade plan
                  </Button>
                </div>
              ) : null}
            </div>
          )}
          {trial?.unlimited && <p className="text-sm font-medium text-success">Unlimited minutes on this plan.</p>}

          {/* What this plan includes beyond minutes. */}
          {(sub?.smsEnabled || sub?.whatsappEnabled || sub?.customCrmEnabled || sub?.multilingualEnabled) && (
            <div className="flex flex-wrap gap-2">
              {sub?.smsEnabled && (
                <Badge variant="neutral" className="gap-1">
                  <MessageSquare className="size-3.5" /> SMS summaries
                </Badge>
              )}
              {sub?.whatsappEnabled && (
                <Badge variant="neutral" className="gap-1">
                  <MessageCircle className="size-3.5" /> WhatsApp
                </Badge>
              )}
              {sub?.customCrmEnabled && (
                <Badge variant="neutral" className="gap-1">
                  <Link2 className="size-3.5" /> Custom CRM
                </Badge>
              )}
              {sub?.multilingualEnabled && (
                <Badge variant="neutral" className="gap-1">
                  <Globe className="size-3.5" /> Multilingual
                </Badge>
              )}
            </div>
          )}

          {/* Auto-renew toggle — accented so this important billing notice stands
              out from the rest of the card. */}
          <div
            className={cn(
              "flex items-start justify-between gap-4 rounded-lg border border-l-4 p-5",
              sub?.autoRenew
                ? "border-primary/25 border-l-primary bg-primary/5"
                : "border-warning/30 border-l-warning bg-warning/5",
            )}
          >
            <div className="min-w-0 space-y-2.5">
              <p className="flex items-center gap-2 text-sm font-semibold">
                Auto-renew &amp; auto-pay
                {sub?.autoRenew ? (
                  <Badge variant="success">On</Badge>
                ) : (
                  <Badge variant="warning">Off</Badge>
                )}
              </p>
              <p className="text-sm leading-loose text-foreground">
                {sub?.autoRenew ? (
                  isTrial ? (
                    <>
                      Your free trial will end after{" "}
                      <mark className="rounded bg-primary/15 px-1.5 py-0.5 font-semibold text-primary">
                        {trial && !trial.unlimited ? `${trial.minutesAllocated} minutes` : "unlimited minutes"}
                      </mark>{" "}
                      of usage
                      {trialTotalDays !== null && (
                        <>
                          {" "}or{" "}
                          <mark className="rounded bg-primary/15 px-1.5 py-0.5 font-semibold text-primary">
                            {trialTotalDays} day{trialTotalDays === 1 ? "" : "s"}
                          </mark>
                        </>
                      )}
                      . After that, your subscription will start automatically at{" "}
                      <mark className="rounded bg-primary/15 px-1.5 py-0.5 font-semibold text-primary">
                        {money(sub?.priceCents ?? 0)}/{intervalLabel(sub?.interval, sub?.intervalCount)}
                      </mark>
                      , so your AI assistant keeps working.
                    </>
                  ) : (
                    <>
                      <span className="font-semibold text-success">On</span> — your{" "}
                      <strong>{sub?.planName}</strong> plan includes{" "}
                      <strong>
                        {planMinutes > 0
                          ? `${planMinutes.toLocaleString()} minutes per ${intervalLabel(sub?.interval, sub?.intervalCount)}`
                          : "unlimited minutes"}
                      </strong>
                      . When those minutes run out{" "}
                      {sub?.currentPeriodEnd && (
                        <>
                          or you reach your renewal date <strong>{fmtDate(sub.currentPeriodEnd)}</strong>{" "}
                        </>
                      )}
                      (whichever comes first), we renew automatically, reset your minutes, and charge your saved
                      card <strong>{money(sub?.priceCents ?? 0)}/{intervalLabel(sub?.interval, sub?.intervalCount)}</strong>{" "}
                      so your AI never stops answering.
                    </>
                  )
                ) : (
                  <>
                    <span className="font-semibold text-warning">Off</span> — your plan ends when the current
                    period finishes with <strong>no further charge</strong>. Calls freeze until you pick a plan
                    again. Turn it back on anytime before then to stay live.
                  </>
                )}
              </p>
            </div>
            <Switch
              checked={!!sub?.autoRenew}
              disabled={togglingRenew}
              // Turning ON is safe → apply instantly. Turning OFF freezes calls at
              // period end → confirm first.
              onCheckedChange={(v) => (v ? toggleAutoRenew(true) : setConfirmDisableRenew(true))}
              className="mt-0.5 shrink-0"
            />
          </div>

          {/* Spell out what the portal does — a bare "Manage billing" button meant nobody found the card change. */}
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-[var(--radius-card)] border border-border bg-muted/40 p-3.5">
            <div className="flex items-start gap-3">
              <span className="mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-xl bg-primary-tint text-primary">
                <CreditCard className="size-4" />
              </span>
              <div className="min-w-0">
                <p className="text-sm font-semibold text-foreground">Payment method</p>
                <p className="text-sm text-muted-foreground">
                  Add a new card, choose which one gets charged, or update your billing details — in
                  Stripe's secure portal.
                </p>
              </div>
            </div>
            <Button size="sm" className="shrink-0 gap-2" onClick={openPortal} disabled={portalBusy}>
              {portalBusy ? "Opening…" : "Manage payment methods"}
              {!portalBusy && <ArrowRight className="size-4" />}
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* Plan grid */}
      <div id="plan-options">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-lg font-semibold">Available plans</h2>
          <span className="text-xs text-muted-foreground">
            All prices are in{" "}
            {[...new Set(plans.map((p) => (p.currency || "USD").toUpperCase()))].join(" / ") || "USD"}.
          </span>
        </div>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {/* Retired (legacy) current plan isn't in the active list, so show it here disabled for comparison. */}
          {sub?.legacy && !plans.some((p) => p.id === currentPlanId) && (
            <Card className="flex flex-col border-warning/40 ring-1 ring-warning/30">
              <CardHeader>
                <CardTitle className="flex flex-wrap items-center gap-2 text-base">
                  {sub.planName ?? "Your plan"}
                  <Badge variant="warning">Legacy</Badge>
                  <Badge variant="success">{isTrial ? "After trial" : "Current"}</Badge>
                </CardTitle>
              </CardHeader>
              <CardContent className="flex flex-1 flex-col gap-3">
                <div>
                  <div>
                    <span className="text-2xl font-bold">{money(sub.priceCents)}</span>
                    <span className="text-sm text-muted-foreground">/{intervalLabel(sub.interval, sub.intervalCount)}</span>
                  </div>
                </div>
                <p className="text-sm text-muted-foreground">
                  {sub.includedMinutes > 0
                    ? `${sub.includedMinutes.toLocaleString()} call minutes / cycle`
                    : "Unlimited minutes"}
                </p>
                {(sub.smsEnabled || sub.whatsappEnabled || sub.customCrmEnabled || sub.multilingualEnabled) && (
                  <div className="flex flex-wrap gap-1.5">
                    {sub.smsEnabled && (
                      <Badge variant="neutral" className="gap-1">
                        <MessageSquare className="size-3" /> SMS
                      </Badge>
                    )}
                    {sub.whatsappEnabled && (
                      <Badge variant="neutral" className="gap-1">
                        <MessageCircle className="size-3" /> WhatsApp
                      </Badge>
                    )}
                    {sub.customCrmEnabled && (
                      <Badge variant="neutral" className="gap-1">
                        <Link2 className="size-3" /> Custom CRM
                      </Badge>
                    )}
                    {sub.multilingualEnabled && (
                      <Badge variant="neutral" className="gap-1">
                        <Globe className="size-3" /> Multilingual
                      </Badge>
                    )}
                  </div>
                )}
                <p className="flex items-start gap-1.5 text-xs text-muted-foreground">
                  <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-warning" />
                  This plan is no longer offered. Upgrade to a current plan for more minutes and features.
                </p>
                <div className="mt-auto pt-2">
                  <Button variant="outline" className="w-full" disabled>
                    Your current plan
                  </Button>
                </div>
              </CardContent>
            </Card>
          )}
          {plans.map((plan) => {
            const { isCurrent, isScheduledTarget, direction, otherCurrency } = planRelation(plan);
            return (
              <Card key={plan.id} className={cn("flex flex-col", isCurrent && "ring-2 ring-primary")}>
                <CardHeader>
                  <CardTitle className="flex items-center gap-2 text-base">
                    {plan.displayName}
                    {plan.recommended && <Badge variant="premium">Popular</Badge>}
                    {isCurrent && <Badge variant="success">{isTrial ? "After trial" : "Current"}</Badge>}
                    {isScheduledTarget && <Badge variant="warning">Scheduled</Badge>}
                  </CardTitle>
                </CardHeader>
                <CardContent className="flex flex-1 flex-col gap-3">
                  <div>
                    <div>
                      <span className="text-2xl font-bold">{money(plan.priceCents, plan.currency)}</span>
                      <span className="text-sm text-muted-foreground">/{intervalLabel(plan.interval, plan.intervalCount)}</span>
                    </div>
                  </div>
                  <p className="text-sm text-muted-foreground">
                    {plan.includedMinutes > 0 ? `${plan.includedMinutes.toLocaleString()} call minutes / cycle` : "Unlimited minutes"}
                  </p>
                  {(plan.smsEnabled || plan.whatsappEnabled || plan.customCrmEnabled || plan.multilingualEnabled) && (
                    <div className="flex flex-wrap gap-1.5">
                      {plan.smsEnabled && (
                        <Badge variant="neutral" className="gap-1">
                          <MessageSquare className="size-3" /> SMS
                        </Badge>
                      )}
                      {plan.whatsappEnabled && (
                        <Badge variant="neutral" className="gap-1">
                          <MessageCircle className="size-3" /> WhatsApp
                        </Badge>
                      )}
                      {plan.customCrmEnabled && (
                        <Badge variant="neutral" className="gap-1">
                          <Link2 className="size-3" /> Custom CRM
                        </Badge>
                      )}
                      {plan.multilingualEnabled && (
                        <Badge variant="neutral" className="gap-1">
                          <Globe className="size-3" /> Multilingual
                        </Badge>
                      )}
                    </div>
                  )}
                  {/* Canonical, cross-page feature order (see buildPlanFeatureRows) so
                      the Plans & Billing cards match the onboarding subscribe cards. */}
                  <ul className="flex flex-col gap-1.5">
                    {buildPlanFeatureRows(plan).map(({ label, included }, i) => (
                      <li key={`${plan.id}-${i}-${label}`} className="flex items-start gap-2 text-sm">
                        {included ? (
                          <Check className="mt-0.5 size-4 shrink-0 text-success" />
                        ) : (
                          <X className="mt-0.5 size-4 shrink-0 text-muted-foreground/70" />
                        )}
                        <span className={cn(!included && "text-muted-foreground")}>{label}</span>
                      </li>
                    ))}
                  </ul>
                  <div className="mt-auto pt-2">
                    {isCurrent ? (
                      <Button variant="outline" className="w-full" disabled>
                        {isTrial ? "Starts after trial" : "Your current plan"}
                      </Button>
                    ) : isScheduledTarget ? (
                      <Button variant="outline" className="w-full" onClick={() => setManageScheduled(true)}>
                        <Clock className="size-4" /> Scheduled — manage
                      </Button>
                    ) : otherCurrency ? (
                      <div className="space-y-1.5">
                        <Button variant="outline" className="w-full" onClick={() => openSwitch(plan)}>
                          <ArrowLeftRight className="size-4" /> Switch to {plan.currency?.toUpperCase()}
                        </Button>
                        <p className="text-center text-xs text-muted-foreground">
                          Billed in {plan.currency?.toUpperCase()}, your plan is in{" "}
                          {sub?.currency?.toUpperCase()} — needs a new card.
                        </p>
                      </div>
                    ) : direction === "upgrade" ? (
                      <Button className="w-full" onClick={() => openChange(plan)}>
                        <ArrowUpCircle className="size-4" /> Upgrade
                      </Button>
                    ) : (
                      <Button variant="outline" className="w-full" onClick={() => openChange(plan)}>
                        <ArrowDownCircle className="size-4" /> Downgrade
                      </Button>
                    )}
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      </div>

      {/* Change-plan modal with proration preview */}
      <Dialog open={!!changeTarget} onOpenChange={(o) => !o && !confirming && setChangeTarget(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>
              {changeIsDowngrade ? "Downgrade" : "Upgrade"} to{" "}
              {changeTarget?.displayName}
            </DialogTitle>
            <DialogDescription>
              {previewing ? "Calculating your exact charge…" : "Review the details before confirming."}
            </DialogDescription>
          </DialogHeader>

          {previewing ? (
            <div className="flex items-center justify-center py-10 text-muted-foreground">
              <Loader2 className="size-6 animate-spin" />
            </div>
          ) : preview ? (
            <div className="space-y-3 text-sm">
              {/* Where you are → where you'll land */}
              <div className="flex items-center gap-2 rounded-xl border border-border bg-warm p-3">
                <div className="min-w-0 flex-1 text-center">
                  <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                    {preview.isTrial
                      ? "Now"
                      : preview.direction === "downgrade"
                        ? `Until ${fmtDate(preview.effectiveAt)}`
                        : "Now"}
                  </p>
                  <p className="truncate text-sm font-semibold">
                    {preview.isTrial ? "Free trial" : preview.currentPlan.name}
                  </p>
                </div>
                <span className="grid size-7 shrink-0 place-items-center rounded-full bg-primary text-primary-foreground">
                  <ArrowRight className="size-4" />
                </span>
                <div className="min-w-0 flex-1 text-center">
                  <p className="text-[11px] font-medium uppercase tracking-wide text-primary">
                    {preview.isTrial
                      ? preview.effectiveAt
                        ? fmtDate(preview.effectiveAt)
                        : "After trial"
                      : preview.direction === "downgrade"
                        ? "Then"
                        : "Today"}
                  </p>
                  <p className="truncate text-sm font-semibold text-primary">{preview.newPlan.name}</p>
                </div>
              </div>

              {preview.isTrial ? (
                <>
                  <div className="rounded-xl border border-primary/25 bg-primary-tint p-4">
                    <div className="flex items-baseline justify-between gap-2">
                      <span className="text-muted-foreground">{preview.newPlan.name} price</span>
                      <span className="whitespace-nowrap">
                        <span className="text-2xl font-bold tracking-tight">
                          {money(preview.newPlan.priceCents, preview.currency)}
                        </span>
                        <span className="text-muted-foreground">/cycle</span>
                      </span>
                    </div>
                    <ul className="mt-3 space-y-1.5">
                      <li className="flex items-start gap-2">
                        <Check className="mt-0.5 size-4 shrink-0 text-success" />
                        <span>
                          {preview.newPlan.includedMinutes > 0
                            ? `${preview.newPlan.includedMinutes.toLocaleString()} minutes every cycle`
                            : "Unlimited minutes"}
                        </span>
                      </li>
                      <li className="flex items-start gap-2">
                        <Check className="mt-0.5 size-4 shrink-0 text-success" />
                        <span>
                          Starts automatically when your trial ends
                          {preview.effectiveAt && (
                            <>
                              {" "}on <strong>{fmtDate(preview.effectiveAt)}</strong>
                            </>
                          )}
                          .
                        </span>
                      </li>
                    </ul>
                  </div>
                  <div className="flex items-center gap-2 rounded-lg bg-success-tint px-3 py-2.5 font-semibold text-success">
                    <ShieldCheck className="size-4 shrink-0" />
                    Nothing is charged today.
                  </div>
                </>
              ) : preview.direction === "downgrade" ? (
                <>
                  <div className="rounded-xl border border-border bg-warm p-4">
                    <div className="flex items-baseline justify-between gap-2">
                      <span className="text-muted-foreground">New price</span>
                      <span className="whitespace-nowrap">
                        <span className="text-2xl font-bold tracking-tight">
                          {money(preview.newPlan.priceCents, preview.currency)}
                        </span>
                        <span className="text-muted-foreground">/cycle</span>
                      </span>
                    </div>
                    <p className="mt-2 text-muted-foreground">
                      You keep <strong className="text-foreground">{preview.currentPlan.name}</strong> and
                      all its minutes until{" "}
                      <strong className="text-foreground">{fmtDate(preview.effectiveAt)}</strong>, then
                      move to {preview.newPlan.name} (
                      {preview.newPlan.includedMinutes > 0
                        ? `${preview.newPlan.includedMinutes.toLocaleString()} min/cycle`
                        : "unlimited minutes"}
                      ).
                    </p>
                    {preview.replacesScheduledPlanName && (
                      <p className="mt-2 flex items-start gap-1.5 text-warning">
                        <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
                        This replaces your scheduled downgrade to {preview.replacesScheduledPlanName}.
                      </p>
                    )}
                  </div>
                  <div className="flex items-center gap-2 rounded-lg bg-success-tint px-3 py-2.5 font-semibold text-success">
                    <ShieldCheck className="size-4 shrink-0" />
                    No charge today.
                  </div>
                </>
              ) : (
                <>
                  {/* Receipt-style breakdown with a clear total */}
                  <div className="overflow-hidden rounded-xl border border-border">
                    <div className="space-y-1.5 bg-warm p-4">
                      <div className="flex justify-between">
                        <span className="text-muted-foreground">{preview.newPlan.name} price</span>
                        <span className="font-medium">
                          {money(preview.newPlan.priceCents, preview.currency)}
                        </span>
                      </div>
                      {preview.creditCents > 0 && (
                        <div className="flex justify-between text-success">
                          <span>Credit — {Math.round(preview.minutesRemaining)} unused minutes</span>
                          <span className="font-medium">
                            −{money(preview.creditCents, preview.currency)}
                          </span>
                        </div>
                      )}
                    </div>
                    <div className="flex items-baseline justify-between border-t border-border bg-primary-tint px-4 py-3">
                      <span className="font-semibold">You pay today</span>
                      <span className="text-2xl font-bold tracking-tight text-primary">
                        {money(preview.amountDueCents, preview.currency)}
                      </span>
                    </div>
                  </div>
                  <div className="flex items-start gap-2 rounded-lg bg-success-tint px-3 py-2.5 text-success">
                    <Sparkles className="mt-0.5 size-4 shrink-0" />
                    <span>
                      Applies instantly — you get{" "}
                      {preview.newPlan.includedMinutes > 0
                        ? `${preview.newPlan.includedMinutes.toLocaleString()} minutes`
                        : "unlimited minutes"}{" "}
                      right away, then renew at {money(preview.newPlan.priceCents, preview.currency)}/cycle
                      {preview.currentPeriodEnd ? ` on ${fmtDate(preview.currentPeriodEnd)}` : ""}.
                    </span>
                  </div>
                  {/* A coupon discounts RENEWALS, not this one-off upgrade invoice — say so or the full total reads as a bug. */}
                  {sub?.discount && sub.discount.cyclesLeft > 0 && (
                    <p className="flex items-start gap-1.5 text-muted-foreground">
                      <Ticket className="mt-0.5 size-3.5 shrink-0" />
                      Your {sub.discount.code} discount applies to your renewals, not to this
                      one-off upgrade charge.
                    </p>
                  )}
                  {preview.replacesScheduledPlanName && (
                    <p className="flex items-start gap-1.5 text-warning">
                      <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
                      This cancels your scheduled downgrade to {preview.replacesScheduledPlanName}.
                    </p>
                  )}
                </>
              )}
              {preview.direction === "same" && !preview.isTrial && (
                <div className="flex items-center gap-2 text-warning">
                  <AlertTriangle className="size-4" /> This plan is the same price as your current one.
                </div>
              )}
            </div>
          ) : null}

          <DialogFooter>
            <Button variant="ghost" onClick={() => setChangeTarget(null)} disabled={confirming}>
              Cancel
            </Button>
            <Button onClick={confirmChange} disabled={previewing || confirming || !preview}>
              {confirming && <Loader2 className="size-4 animate-spin" />}
              {isTrial
                ? changeIsDowngrade
                  ? "Downgrade"
                  : "Upgrade"
                : changeIsDowngrade
                  ? "Schedule downgrade"
                  : (preview?.amountDueCents ?? 0) > 0
                    ? `Pay ${money(preview?.amountDueCents ?? 0, preview?.currency)} & upgrade`
                    : "Upgrade now"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Manage an already-scheduled downgrade (opened from the "Scheduled" plan tile). */}
      {/* Cross-currency switch: Stripe locks a customer to one currency, so this is a NEW subscription on a
          NEW customer with a fresh card. The existing plan keeps running until that payment succeeds. */}
      <Dialog open={!!switchTarget} onOpenChange={(o) => !o && void closeSwitch()}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Switch to {switchTarget?.displayName}</DialogTitle>
            <DialogDescription>
              {switchTarget?.currency?.toUpperCase()} plans bill on a separate subscription from your
              current {sub?.currency?.toUpperCase()} one, so this needs your card again.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            <div className="rounded-lg border border-border bg-muted/40 p-3 text-sm">
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground">New plan</span>
                <span className="font-semibold">
                  {switchTarget ? money(switchTarget.priceCents, switchTarget.currency) : "—"}/
                  {intervalLabel(switchTarget?.interval, switchTarget?.intervalCount)}
                </span>
              </div>
              <div className="mt-1 flex items-center justify-between">
                <span className="text-muted-foreground">Replaces</span>
                <span>
                  {sub?.planName} ({money(sub?.priceCents ?? 0, sub?.currency)}/
                  {intervalLabel(sub?.interval, sub?.intervalCount)})
                </span>
              </div>
            </div>

            {/* Stripe can't credit unused time across currencies — fresh billing period, not a prorated swap. */}
            <div className="rounded-lg border border-warning/40 bg-warning-tint px-3 py-2">
              <p className="text-xs text-warning">
                This starts a new billing period today. Any unused time on your current plan is not
                carried over or refunded — a payment in one currency can't be credited against
                another.
              </p>
            </div>

            {switchStarting ? (
              <div className="flex justify-center py-8 text-muted-foreground">
                <Loader2 className="size-6 animate-spin" />
              </div>
            ) : (
              <CurrencySwitchForm
                clientSecret={switchSecret}
                priceLabel={
                  switchTarget ? money(switchTarget.priceCents, switchTarget.currency) : ""
                }
                onCancel={() => void closeSwitch()}
                onDone={async () => {
                  setSwitchTarget(null);
                  setSwitchSecret(null);
                  await reload();
                }}
              />
            )}
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={manageScheduled} onOpenChange={(o) => !o && !cancelling && setManageScheduled(false)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Downgrade already scheduled</DialogTitle>
            <DialogDescription>Here's what's set up — you can keep your current plan instead.</DialogDescription>
          </DialogHeader>
          <div className="space-y-3 text-sm">
            <div className="rounded-lg border border-warning/40 bg-warning-tint p-3 space-y-1.5">
              <div className="flex items-start gap-2">
                <Clock className="mt-0.5 size-4 shrink-0 text-warning" />
                <p className="text-muted-foreground">
                  You're on <strong>{sub?.planName}</strong> ({money(sub?.priceCents ?? 0)}/{intervalLabel(sub?.interval, sub?.intervalCount)})
                  until <strong>{fmtDate(scheduled?.effectiveAt ?? null)}</strong>. On that date you'll move to{" "}
                  <strong>{scheduled?.name}</strong>.
                </p>
              </div>
              <p className="text-muted-foreground">
                You keep your current plan and minutes until then — <strong className="text-foreground">no charge
                today</strong>, and nothing changes before the switch date.
              </p>
            </div>
            <p className="text-xs text-muted-foreground">
              Want to stay on {sub?.planName}? Keep your plan below. To switch to a different plan instead, close this
              and pick another plan.
            </p>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setManageScheduled(false)} disabled={cancelling}>
              Close
            </Button>
            <Button onClick={cancelDowngrade} disabled={cancelling}>
              {cancelling && <Loader2 className="size-4 animate-spin" />}
              Keep my plan
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Confirm before renewing — it charges the saved card now. */}
      <Dialog open={confirmRenew} onOpenChange={(o) => !o && !renewing && setConfirmRenew(false)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <RefreshCw className="size-5 text-primary" /> Renew {sub?.planName ?? "plan"} now?
            </DialogTitle>
            <DialogDescription>Here's what happens when you renew.</DialogDescription>
          </DialogHeader>
          <div className="space-y-3 text-sm">
            <ul className="space-y-2">
              <li className="flex items-start gap-2">
                <CreditCard className="mt-0.5 size-4 shrink-0 text-primary" />
                <span>
                  We'll charge your saved card{" "}
                  <strong>
                    {money(sub?.priceCents ?? 0)}/{intervalLabel(sub?.interval, sub?.intervalCount)}
                  </strong>{" "}
                  for a fresh period — today.
                </span>
              </li>
              <li className="flex items-start gap-2">
                <RefreshCw className="mt-0.5 size-4 shrink-0 text-success" />
                <span>
                  Your <strong>{sub?.includedMinutes ?? 0} minutes reset</strong> and your AI comes
                  back online (calls unfreeze).
                </span>
              </li>
              <li className="flex items-start gap-2">
                <Check className="mt-0.5 size-4 shrink-0 text-success" />
                <span>
                  Auto-renew is turned <strong>back on</strong> so it won't pause again at the next
                  cycle.
                </span>
              </li>
            </ul>

            {/* What the renewed plan includes, so the user sees what they're paying for. */}
            <div className="rounded-lg border border-border bg-warm p-3">
              <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                Your {sub?.planName ?? "plan"} includes
              </p>
              {/* Minutes row on top, then the shared canonical feature order (same helper
                  the plan cards use) so this modal matches the rest of the page. */}
              <ul className="mt-2 space-y-1.5">
                {[
                  {
                    label:
                      (sub?.includedMinutes ?? 0) > 0
                        ? `${(sub?.includedMinutes ?? 0).toLocaleString()} call minutes / cycle`
                        : "Unlimited call minutes",
                    included: true,
                  },
                  ...buildPlanFeatureRows(
                    currentRenewPlan ?? {
                      smsEnabled: Boolean(sub?.smsEnabled),
                      smsToCallerEnabled: Boolean(sub?.smsToCallerEnabled),
                      whatsappEnabled: Boolean(sub?.whatsappEnabled),
                      customCrmEnabled: Boolean(sub?.customCrmEnabled),
                      multilingualEnabled: Boolean(sub?.multilingualEnabled),
                      transcriptsEnabled: true,
                      callTransferEnabled: Boolean(sub?.callTransferEnabled),
                      callTransferLimit: sub?.callTransferLimit ?? 0,
                      voiceCategoryName: null,
                    },
                  ),
                ]
                  .map((f) => (
                    <li key={f.label} className="flex items-start gap-2">
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
            </div>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setConfirmRenew(false)} disabled={renewing}>
              Cancel
            </Button>
            <Button onClick={renewPlan} disabled={renewing}>
              {renewing && <Loader2 className="size-4 animate-spin" />}
              Renew &amp; pay {money(sub?.priceCents ?? 0)}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Confirm before turning auto-renew off — it freezes the account at period end. */}
      <Dialog
        open={confirmDisableRenew}
        onOpenChange={(o) => !o && !togglingRenew && setConfirmDisableRenew(false)}
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <AlertTriangle className="size-5 text-warning" /> Turn off auto-renew?
            </DialogTitle>
            <DialogDescription>Here's what happens if you turn it off.</DialogDescription>
          </DialogHeader>
          <div className="space-y-3 text-sm">
            <ul className="space-y-2">
              {/* Only when a downgrade is queued: turning auto-renew off releases it,
                  since there's no next cycle for the scheduled plan to move into. */}
              {scheduled && (
                <li className="flex items-start gap-2">
                  <AlertTriangle className="mt-0.5 size-4 shrink-0 text-danger" />
                  <span>
                    Your scheduled downgrade to <strong>{scheduled.name}</strong>
                    {scheduled.effectiveAt ? <> on <strong>{fmtDate(scheduled.effectiveAt)}</strong></> : ""}{" "}
                    will be cancelled — with no next cycle, there's nothing to move into.
                  </span>
                </li>
              )}
              <li className="flex items-start gap-2">
                <Clock className="mt-0.5 size-4 shrink-0 text-warning" />
                <span>
                  Your plan won't renew or charge your card — it ends when the current period finishes
                  {sub?.currentPeriodEnd ? <> on <strong>{fmtDate(sub.currentPeriodEnd)}</strong></> : ""}.
                </span>
              </li>
              <li className="flex items-start gap-2">
                <AlertTriangle className="mt-0.5 size-4 shrink-0 text-danger" />
                <span>
                  After that, <strong>your AI stops answering and all calls freeze</strong> until you pick a
                  plan again.
                </span>
              </li>
              <li className="flex items-start gap-2">
                <RefreshCw className="mt-0.5 size-4 shrink-0 text-primary" />
                <span>
                  You can turn auto-renew back on anytime before then to stay live — no charge today.
                </span>
              </li>
            </ul>
          </div>
          <DialogFooter>
            <Button
              variant="ghost"
              onClick={() => setConfirmDisableRenew(false)}
              disabled={togglingRenew}
            >
              Keep auto-renew on
            </Button>
            <Button
              variant="danger"
              onClick={async () => {
                await toggleAutoRenew(false);
                setConfirmDisableRenew(false);
              }}
              disabled={togglingRenew}
            >
              {togglingRenew && <Loader2 className="size-4 animate-spin" />}
              Turn off auto-renew
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
