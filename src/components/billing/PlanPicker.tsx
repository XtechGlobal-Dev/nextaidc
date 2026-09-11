import { useEffect, useRef, useState } from "react";
import {
  ArrowRight,
  Check,
  X,
  Gift,
  Globe,
  Link2,
  Loader2,
  MessageCircle,
  MessageSquare,
  Mic,
  PhoneCall,
  Ticket,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Skeleton } from "@/components/ui/skeleton";
import { formatMoney, couponDiscountCents } from "@/lib/currency";
import { buildPlanFeatureRows } from "@/lib/planFeatures";
import { planAnalyticsParams, planCardId, planSlug } from "@/lib/planSlug";
import { trackEvent, type FunnelContext } from "@/lib/analytics";
import { cn } from "@/lib/utils";
import { api, ApiError, type CouponValidation, type SubscriptionPlan } from "@/lib/api";

export interface PlanPickerProps {
  /** null while loading — renders the skeleton. */
  plans: SubscriptionPlan[] | null;
  trialInfo: { days: number; minutes: number } | null;
  planId: string | null;
  onSelectPlan: (id: string) => void;
  autoRenew: boolean;
  onAutoRenewChange: (v: boolean) => void;
  onContinue: () => void;
  busy?: boolean;
  /** "page" adds the mobile sticky total bar; "modal" keeps it inline. */
  variant?: "page" | "modal";
  /** Continue button label (defaults to "Continue to payment"). */
  continueLabel?: string;
  /** True when the free trial is already used up — the card is charged TODAY and
   *  the plan activates immediately (no trial). Flips all "free trial / $0 due
   *  today" copy to "charged now / plan activates immediately". */
  immediate?: boolean;
  /**
   * Called whenever the applied coupon changes — with the validated coupon, and
   * with null when it's cleared or stops applying to the selected plan. The
   * parent sends `.code` to `api.billing.subscribe`, and needs the rest so any
   * total it renders itself agrees with the one shown here. Omit to hide the
   * coupon field entirely.
   */
  onCouponChange?: (coupon: AppliedCoupon | null) => void;
  /** A code the parent already holds, so it survives leaving and returning to
   *  this step (e.g. "Back to plans" from the card form). */
  couponCode?: string | null;
}

/* ---------------------------- Coupon field ---------------------------- */

/**
 * "Have a coupon code?" — validates against the SELECTED plan and reports the
 * applied code upward.
 *
 * Re-validates whenever the plan changes, because eligibility is per-plan: a
 * Starter-only code must visibly fall off when the user switches to Pro, rather
 * than silently surviving to a checkout that then rejects it.
 */
/** A coupon that validated — the `valid: true` arm of CouponValidation. */
export type AppliedCoupon = Extract<CouponValidation, { valid: true }>;

function CouponField({
  planId,
  initialCode,
  onApplied,
  registerFlush,
}: {
  planId: string | null;
  /** A code the parent is already holding — set when the user reached the card
   *  step, backed out, and landed here again. Re-checked on mount so the applied
   *  chip and the discounted total survive the round trip, instead of the parent
   *  silently keeping a code the field no longer shows. */
  initialCode?: string | null;
  onApplied: (coupon: AppliedCoupon | null) => void;
  /** Hands the parent a `flush()` it can await before continuing to payment. */
  registerFlush: (flush: () => Promise<boolean>) => void;
}) {
  const [open, setOpen] = useState(!!initialCode);
  const [code, setCode] = useState(initialCode ?? "");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<CouponValidation | null>(null);

  const applied = result?.valid ? result : null;

  async function check(raw: string, plan: string): Promise<boolean> {
    setBusy(true);
    try {
      const res = await api.billing.validateCoupon(raw, plan);
      setResult(res);
      onApplied(res.valid ? res : null);
      return res.valid;
    } catch (e) {
      setResult({ valid: false, message: e instanceof ApiError ? e.message : "Couldn't check that code." });
      onApplied(null);
      return false;
    } finally {
      setBusy(false);
    }
  }

  /**
   * Called before the parent continues to payment. A code that was typed but
   * never applied must NOT be silently dropped — that would charge full price to
   * someone who believes they have a discount. So validate it here and block the
   * step if it doesn't hold up; clearing the field is the way past.
   */
  useEffect(() => {
    registerFlush(async () => {
      const typed = code.trim();
      if (!typed || !planId) return true; // nothing pending
      if (applied && applied.code === typed) return true; // already applied
      return check(typed, planId);
    });
  }, [code, planId, applied, registerFlush]);

  // Two triggers, one effect:
  //  • mount with a code the parent is still holding (they came back from the
  //    card step) → re-check so the chip and discounted total are restored;
  //  • the plan changed while a code was applied → re-check against the new
  //    plan, since eligibility is per-plan.
  useEffect(() => {
    const pending = applied?.code ?? initialCode?.trim();
    if (!pending || !planId) return;
    void check(pending, planId);
    // Only the plan switching should retrigger this, not our own state updates.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [planId]);

  function clear() {
    setCode("");
    setResult(null);
    onApplied(null);
  }

  if (applied) {
    return (
      <div className="flex flex-wrap items-center gap-3 rounded-[var(--radius-card)] border border-success/40 bg-success-tint px-4 py-3">
        <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-success text-white shadow-sm">
          <Check className="size-4.5" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold text-foreground">
            {applied.displayName}{" "}
            <span className="font-mono text-xs font-normal text-muted-foreground">
              ({applied.code})
            </span>
          </p>
          <p className="text-xs text-muted-foreground">
            {[
              applied.percentOff ? `${applied.percentOff}% off` : null,
              applied.bonusMinutes ? `+${applied.bonusMinutes} bonus minutes` : null,
            ]
              .filter(Boolean)
              .join(" · ")}
            {" — "}
            {applied.durationCycles === 1
              ? "on your first charge"
              : `for your first ${applied.durationCycles} billing cycles`}
          </p>
        </div>
        <button
          type="button"
          onClick={clear}
          className="text-xs font-medium text-muted-foreground underline-offset-2 hover:text-danger hover:underline"
        >
          Remove
        </button>
      </div>
    );
  }

  // Collapsed — a full-width panel, not a text link. Sitting between the
  // auto-renew card and the total bar, a bare link read as fine print and got
  // skipped; the dashed border marks it as something you can act on without
  // competing with the primary CTA.
  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="group flex w-full items-center gap-3 rounded-[var(--radius-card)] border border-dashed border-primary/45 bg-primary-tint/40 px-4 py-3 text-left transition-colors hover:border-primary hover:bg-primary-tint"
      >
        <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-primary text-primary-foreground shadow-sm">
          <Ticket className="size-4.5" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-semibold text-foreground">Have a coupon code?</span>
          <span className="block text-xs text-muted-foreground">
            Enter it now to see your discount before you pay.
          </span>
        </span>
        <span className="shrink-0 text-sm font-semibold text-primary group-hover:underline">
          Add code
        </span>
      </button>
    );
  }

  return (
    <div className="rounded-[var(--radius-card)] border border-primary/45 bg-primary-tint/40 px-4 py-3">
      <div className="flex items-center gap-3">
        <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-primary text-primary-foreground shadow-sm">
          <Ticket className="size-4.5" />
        </span>
        <p className="min-w-0 flex-1 text-sm font-semibold text-foreground">Coupon code</p>
        <button
          type="button"
          onClick={() => setOpen(false)}
          className="shrink-0 text-xs font-medium text-muted-foreground hover:text-foreground"
        >
          Cancel
        </button>
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Input
          autoFocus
          value={code}
          onChange={(e) => setCode(e.target.value.toUpperCase())}
          onKeyDown={(e) => {
            if (e.key === "Enter" && code.trim() && planId) {
              e.preventDefault();
              void check(code.trim(), planId);
            }
          }}
          // Check as soon as they tab/click away, so the discount (or the reason
          // it doesn't apply) is visible without hunting for the Apply button.
          // Only reachable while nothing is applied — an applied coupon renders
          // the chip above instead of this input.
          onBlur={() => {
            const typed = code.trim();
            if (typed && planId) void check(typed, planId);
          }}
          placeholder="Enter code"
          aria-label="Coupon code"
          className="h-10 w-full max-w-[220px] bg-card font-mono uppercase tracking-wide"
        />
        <Button
          type="button"
          onClick={() => planId && void check(code.trim(), planId)}
          disabled={busy || !code.trim() || !planId}
        >
          {busy && <Loader2 className="size-4 animate-spin" />}
          Apply
        </Button>
      </div>
      {result && !result.valid && (
        <p className="mt-2 text-xs font-medium text-danger">{result.message}</p>
      )}
    </div>
  );
}

/* --------- Loading skeleton — mirrors the plan-select layout below --------- */
function PlanSelectSkeleton() {
  return (
    <div className="space-y-4">
      <div className="flex items-start gap-3 rounded-[var(--radius-card)] border border-border bg-card p-4 shadow-[var(--shadow-soft)]">
        <Skeleton className="size-9 shrink-0 rounded-xl" />
        <div className="min-w-0 flex-1 space-y-2 py-0.5">
          <Skeleton className="h-4 w-44" />
          <Skeleton className="h-3.5 w-full max-w-xl" />
          <Skeleton className="h-3.5 w-2/3 max-w-md" />
        </div>
      </div>
      <div className="flex items-baseline justify-between gap-3">
        <Skeleton className="hidden h-5 w-36 lg:block" />
        <Skeleton className="ml-auto h-4 w-28" />
      </div>
      <div className="grid items-stretch gap-4 sm:grid-cols-2 lg:grid-cols-3 lg:gap-5">
        {Array.from({ length: 3 }).map((_, i) => (
          <div
            key={i}
            className="relative flex flex-col rounded-[var(--radius-card)] border border-border bg-card p-5 pt-6 shadow-[var(--shadow-soft)]"
          >
            {i === 1 && (
              <Skeleton className="absolute -top-3 left-1/2 h-5 w-28 -translate-x-1/2 rounded-full" />
            )}
            <Skeleton className="absolute right-5 top-5 size-5 rounded-full" />
            <Skeleton className="h-4 w-20" />
            <Skeleton className="mt-2 h-8 w-32" />
            <Skeleton className="mt-1.5 h-3.5 w-28" />
            <Skeleton className="mt-3 h-7 w-40 rounded-full" />
            <div className="mt-4 space-y-3 border-t border-border pt-4">
              {Array.from({ length: 6 }).map((_, r) => (
                <div key={r} className="flex items-center gap-2.5">
                  <Skeleton className="size-4 shrink-0 rounded-full" />
                  <Skeleton className={cn("h-3.5", r % 2 === 0 ? "w-40" : "w-32")} />
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * The "choose a plan" step, shared by the /subscribe page and the in-dashboard
 * number-setup wizard: trial banner, plan cards, auto-renew toggle, and the
 * total + continue bar. Presentational — the parent owns the plans/planId state
 * and what "continue" does (usually: start a subscription → collect a card).
 */
export function PlanPicker({
  plans,
  trialInfo,
  planId,
  onSelectPlan,
  autoRenew,
  onAutoRenewChange,
  onContinue,
  busy = false,
  variant = "page",
  continueLabel = "Continue to payment",
  immediate = false,
  onCouponChange,
  couponCode,
}: PlanPickerProps) {
  const money = formatMoney;
  const selectedPlan = plans?.find((p) => p.id === planId) ?? null;
  const listPriceCents = selectedPlan?.priceCents ?? 0;
  const trialLabel = trialInfo ? `${trialInfo.days}-day free trial` : "Free trial";

  const [coupon, setCoupon] = useState<AppliedCoupon | null>(null);
  // Validates a typed-but-unapplied code before we leave this step. Defaults to
  // "nothing pending" so the button works when the coupon field isn't rendered.
  const flushCoupon = useRef<() => Promise<boolean>>(async () => true);
  const [continuing, setContinuing] = useState(false);
  // The validate endpoint prices the discount against the selected plan, so its
  // total is authoritative — but only while it matches the plan on screen.
  const discountCents = couponDiscountCents(listPriceCents, coupon?.percentOff);
  const totalCents = Math.max(0, listPriceCents - discountCents);

  function handleApplied(applied: AppliedCoupon | null) {
    setCoupon(applied);
    onCouponChange?.(applied);
  }

  // Same two funnels the card step reports, so plan → card can be joined in GA4.
  const analyticsContext: FunnelContext = variant === "page" ? "subscribe_page" : "quick_setup";

  /**
   * A plan card was clicked. Reports the choice to GTM before selecting, so the
   * event carries the plan the user just picked rather than the one leaving.
   * Re-clicking the already-selected card still fires — it's a deliberate
   * "yes, this one", and GA4's own `select_item` behaves the same way.
   *
   * Note this does NOT fire for the plan that is pre-selected on load (the
   * admin's default): nobody chose it. `plan_checkout_started` below is the
   * event that always names the plan they actually went to payment with.
   */
  function handleSelectPlan(plan: SubscriptionPlan) {
    trackEvent("select_plan", {
      ...planAnalyticsParams(plan),
      plan_context: analyticsContext,
      plan_recommended: Boolean(plan.recommended),
    });
    onSelectPlan(plan.id);
  }

  /**
   * A code left sitting in the field unapplied is validated before we move on.
   * If it doesn't hold up we stay put with the reason on screen — continuing
   * would charge full price to someone who thinks a discount is applied.
   */
  async function handleContinue() {
    setContinuing(true);
    try {
      if (!(await flushCoupon.current())) return;
      // The conversion-shaped signal: this names the plan they're paying for,
      // including the pre-selected default they never clicked. Fired only once
      // the coupon check passes, i.e. only when we really do move on.
      if (selectedPlan) {
        trackEvent("plan_checkout_started", {
          ...planAnalyticsParams(selectedPlan),
          plan_context: analyticsContext,
          plan_auto_renew: autoRenew,
          // What they'll actually be charged, after any coupon.
          value: totalCents / 100,
          coupon: coupon?.code ?? undefined,
        });
      }
      onContinue();
    } finally {
      setContinuing(false);
    }
  }

  if (plans === null) return <PlanSelectSkeleton />;
  if (plans.length === 0) {
    return (
      <div className="rounded-[var(--radius-card)] border border-border bg-card py-16 text-center text-sm text-muted-foreground shadow-[var(--shadow-soft)]">
        No plans are available yet. Please check back soon.
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Reassurance banner — free-trial framing normally; "charged today" framing
          once the free trial is used up (immediate charge, no second trial). */}
      <div className="flex items-start gap-3 rounded-[var(--radius-card)] border border-primary/20 bg-gradient-to-r from-primary-tint to-primary-tint-soft p-4">
        <span className="mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-xl bg-primary text-primary-foreground shadow-sm">
          <Gift className="size-5" />
        </span>
        {immediate ? (
          <div className="min-w-0">
            <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm font-semibold text-foreground">
              Your free trial has ended
              <span className="rounded-full bg-primary/15 px-2.5 py-0.5 text-xs font-bold text-primary">
                Billed today
              </span>
            </p>
            <p className="mt-1 text-sm leading-relaxed text-muted-foreground">
              Pick a plan to keep going — we{" "}
              <span className="font-medium text-foreground">charge your card today</span> and your
              plan activates right away. Cancel anytime.
            </p>
          </div>
        ) : (
          <div className="min-w-0">
            <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm font-semibold text-foreground">
              {trialLabel}
              <span className="rounded-full bg-primary/15 px-2.5 py-0.5 text-xs font-bold text-primary">
                Billed at go-live
              </span>
            </p>
            <p className="mt-1 text-sm leading-relaxed text-muted-foreground">
              Your card is saved securely now. The moment you{" "}
              <span className="font-medium text-foreground">claim your number to go live</span>, your{" "}
              {selectedPlan ? (
                <span className="font-medium text-foreground">{selectedPlan.displayName}</span>
              ) : (
                "chosen"
              )}{" "}
              plan activates and we charge your saved card
              {selectedPlan ? (
                <>
                  {" "}
                  <span className="font-medium text-foreground">
                    {money(selectedPlan.priceCents, selectedPlan.currency)}
                  </span>
                </>
              ) : (
                ""
              )}
              .{" "}
              {/* Only the quick-setup modal actually offers a "Skip for now" button —
                  promising one on the full-page picker (where the user is here because
                  they must be) sends them hunting for a control that doesn't exist. */}
              {variant === "modal" ? (
                <>
                  Prefer to explore first? Skip for now to stay on your free trial
                  {trialInfo
                    ? ` (auto-billed after ${trialInfo.days} days or ${trialInfo.minutes} call minutes)`
                    : ""}
                  .{" "}
                </>
              ) : trialInfo ? (
                <>
                  Your free trial runs for {trialInfo.days} days or {trialInfo.minutes} call
                  minutes, whichever comes first.{" "}
                </>
              ) : null}
              Cancel anytime.
            </p>
          </div>
        )}
      </div>

      {/* Plans */}
      <div className="flex items-baseline justify-between gap-3">
        <h3 className="hidden text-base font-semibold text-foreground lg:block">Choose your plan</h3>
        <p className="text-sm text-muted-foreground">
          All prices in {[...new Set(plans.map((p) => (p.currency || "USD").toUpperCase()))].join(" / ")}
        </p>
      </div>
      <div
        className={cn(
          "grid items-stretch gap-4 lg:gap-5",
          plans.length <= 2 ? "sm:grid-cols-2" : "sm:grid-cols-2 lg:grid-cols-3",
        )}
      >
        {plans.map((plan) => {
          const active = plan.id === planId;
          const featureRows = buildPlanFeatureRows(plan);
          const slug = planSlug(plan);
          return (
            <button
              key={plan.id}
              type="button"
              onClick={() => handleSelectPlan(plan)}
              /* Stable per-plan handles for GTM click triggers, CSS selectors and
                 e2e tests — readable in a report, unlike the cuid `plan.id`. */
              id={planCardId(plan)}
              data-plan-slug={slug}
              data-plan-id={plan.id}
              data-plan-name={plan.displayName}
              data-plan-price={plan.priceCents / 100}
              data-plan-currency={(plan.currency || "USD").toUpperCase()}
              data-plan-interval={plan.interval}
              data-plan-selected={active}
              aria-pressed={active}
              className={cn(
                "relative flex flex-col rounded-[var(--radius-card)] border bg-card p-5 pt-6 text-left transition-all duration-200",
                active
                  ? "border-primary shadow-[var(--shadow-panel)] ring-1 ring-primary"
                  : "border-border shadow-[var(--shadow-soft)] hover:-translate-y-0.5 hover:border-primary/40 hover:shadow-[var(--shadow-panel)]",
              )}
            >
              {plan.recommended && (
                <span className="absolute -top-3 left-1/2 -translate-x-1/2 rounded-full bg-primary px-3.5 py-1 text-[10px] font-bold uppercase tracking-widest text-primary-foreground shadow-sm">
                  Most popular
                </span>
              )}

              <span
                className={cn(
                  "absolute right-5 top-5 flex size-5 items-center justify-center rounded-full border-2 transition-colors",
                  active ? "border-primary bg-primary" : "border-border bg-transparent",
                )}
              >
                {active && <Check className="size-3 text-primary-foreground" strokeWidth={3} />}
              </span>

              <p className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
                {plan.displayName}
              </p>
              <p className="mt-2 flex items-baseline gap-1.5">
                <span className="text-3xl font-bold tracking-tight text-foreground">
                  {money(plan.priceCents, plan.currency)}
                </span>
                <span className="text-sm text-muted-foreground">/ {plan.interval}</span>
              </p>
              {plan.description && (
                <p className="mt-1 text-sm text-muted-foreground">{plan.description}</p>
              )}

              <div className="mt-3 flex flex-wrap items-center gap-2">
                {trialInfo && !immediate && (
                  <span className="inline-flex items-center gap-1.5 rounded-full bg-success/10 px-3 py-1 text-xs font-semibold text-success">
                    <Gift className="size-3.5" />
                    {trialLabel}
                  </span>
                )}
                <span
                  className={cn(
                    "inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-semibold",
                    plan.includedMinutes > 0 ? "bg-primary-tint text-primary" : "bg-success/10 text-success",
                  )}
                >
                  <PhoneCall className="size-3.5" />
                  {plan.includedMinutes > 0
                    ? `${plan.includedMinutes.toLocaleString()} call minutes / ${plan.interval}`
                    : "Unlimited minutes"}
                </span>
                {plan.smsEnabled && (
                  <span className="inline-flex items-center gap-1.5 rounded-full bg-muted px-3 py-1 text-xs font-medium text-foreground">
                    <MessageSquare className="size-3.5" /> SMS
                  </span>
                )}
                {plan.whatsappEnabled && (
                  <span className="inline-flex items-center gap-1.5 rounded-full bg-muted px-3 py-1 text-xs font-medium text-foreground">
                    <MessageCircle className="size-3.5" /> WhatsApp
                  </span>
                )}
                {plan.customCrmEnabled && (
                  <span className="inline-flex items-center gap-1.5 rounded-full bg-muted px-3 py-1 text-xs font-medium text-foreground">
                    <Link2 className="size-3.5" /> Custom CRM
                  </span>
                )}
                {plan.multilingualEnabled && (
                  <span className="inline-flex items-center gap-1.5 rounded-full bg-muted px-3 py-1 text-xs font-medium text-foreground">
                    <Globe className="size-3.5" /> Multilingual
                  </span>
                )}
                {plan.voiceCategoryName && (
                  <span className="inline-flex items-center gap-1.5 rounded-full bg-muted px-3 py-1 text-xs font-medium text-foreground">
                    <Mic className="size-3.5" /> {plan.voiceCategoryName}
                  </span>
                )}
              </div>

              <ul className="mt-4 flex-1 space-y-2 border-t border-border pt-4">
                {featureRows.map(({ label, included }, i) => (
                  <li
                    key={`${plan.id}-${i}-${label}`}
                    className="flex items-start gap-2.5 text-sm leading-normal text-foreground/90"
                  >
                    {included ? (
                      <span className="mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full bg-success/15">
                        <Check className="size-3 text-success" strokeWidth={3} />
                      </span>
                    ) : (
                      <span className="mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full bg-muted">
                        <X className="size-3 text-muted-foreground/70" strokeWidth={3} />
                      </span>
                    )}
                    <span className={cn(!included && "text-muted-foreground")}>{label}</span>
                  </li>
                ))}
              </ul>
            </button>
          );
        })}
      </div>

      {/* Auto-renew toggle */}
      <div className="flex items-start justify-between gap-6 rounded-[var(--radius-card)] border border-border bg-card p-4 shadow-[var(--shadow-soft)]">
        <div className="min-w-0">
          <p className="text-sm font-semibold">Auto-renew &amp; auto-pay</p>
          <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">
            {immediate ? (
              autoRenew ? (
                <>
                  <span className="font-medium text-foreground">On</span> — your{" "}
                  {selectedPlan ? (
                    <>
                      <strong className="text-foreground">{selectedPlan.displayName}</strong> plan
                      renews automatically each {selectedPlan.interval} and we charge your saved card{" "}
                      <strong className="text-foreground">
                        {money(selectedPlan.priceCents, selectedPlan.currency)}/{selectedPlan.interval}
                      </strong>
                    </>
                  ) : (
                    "plan renews automatically and we charge your saved card"
                  )}{" "}
                  so your AI keeps answering. Cancel anytime.
                </>
              ) : (
                <>
                  <span className="font-medium text-foreground">Off</span> — your plan ends when this
                  period finishes with <span className="font-medium text-foreground">no further charge</span>.
                  Calls pause until you pick a plan again. You can turn this back on anytime.
                </>
              )
            ) : autoRenew ? (
              <>
                <span className="font-medium text-foreground">On</span> — your free trial gives you{" "}
                {trialInfo ? (
                  <strong className="text-foreground">
                    {trialInfo.minutes} call minutes or {trialInfo.days} day{trialInfo.days === 1 ? "" : "s"}
                  </strong>
                ) : (
                  "a set number of minutes and days"
                )}{" "}
                (whichever runs out first). When it ends, your{" "}
                {selectedPlan ? (
                  <>
                    <strong className="text-foreground">{selectedPlan.displayName}</strong> plan starts
                    and we charge your saved card{" "}
                    <strong className="text-foreground">
                      {money(selectedPlan.priceCents, selectedPlan.currency)}/{selectedPlan.interval}
                    </strong>
                  </>
                ) : (
                  "selected plan starts and we charge your saved card"
                )}
                , renewing each period so your AI keeps answering.{" "}
                <span className="font-medium text-foreground">Nothing is charged today.</span> Cancel
                anytime.
              </>
            ) : (
              <>
                <span className="font-medium text-foreground">Off</span> — your plan ends when the
                period finishes with <span className="font-medium text-foreground">no charge</span>.
                Calls pause until you pick a plan again. You can turn this back on anytime.
              </>
            )}
          </p>
        </div>
        <Switch checked={autoRenew} onCheckedChange={onAutoRenewChange} className="mt-0.5 shrink-0" />
      </div>

      {/* Coupon — omitted entirely when the parent doesn't accept one */}
      {onCouponChange && (
        <CouponField
          planId={planId}
          initialCode={couponCode}
          onApplied={handleApplied}
          registerFlush={(fn) => {
            flushCoupon.current = fn;
          }}
        />
      )}

      {/* Total + continue */}
      <div
        className={cn(
          "flex flex-wrap items-center justify-between gap-4 rounded-[var(--radius-card)] border border-border bg-card p-4",
          variant === "page"
            ? "sticky bottom-3 z-20 shadow-[var(--shadow-panel)] lg:static lg:shadow-[var(--shadow-soft)]"
            : "shadow-[var(--shadow-soft)]",
        )}
      >
        <div>
          <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
            {immediate ? "Due today" : "Due at go-live"}
          </p>
          <p className="mt-0.5 flex items-baseline gap-1.5">
            {discountCents > 0 && (
              <span className="text-base font-medium text-muted-foreground line-through">
                {money(listPriceCents, selectedPlan?.currency)}
              </span>
            )}
            <span className="text-2xl font-bold tracking-tight">
              {money(totalCents, selectedPlan?.currency)}
            </span>
            {selectedPlan && <span className="text-sm text-muted-foreground">/ {selectedPlan.interval}</span>}
          </p>
          <p className="mt-0.5 text-sm font-medium text-success">
            {immediate
              ? "Charged today — your plan activates immediately"
              : "Charged when you claim your number — your plan activates instantly"}
          </p>
          {coupon && coupon.durationCycles > 0 && discountCents > 0 && (
            <p className="mt-0.5 text-xs text-muted-foreground">
              {coupon.durationCycles === 1
                ? `${coupon.code} applies to this charge only — it renews at ${money(listPriceCents, selectedPlan?.currency)} after that.`
                : `${coupon.code} applies to your first ${coupon.durationCycles} charges, then it renews at ${money(listPriceCents, selectedPlan?.currency)}.`}
            </p>
          )}
        </div>
        <Button
          size="lg"
          onClick={handleContinue}
          disabled={busy || continuing || !planId}
          /* Carries the selected plan too, so a GTM click trigger on this button
             alone can attribute the checkout without reading the cards. */
          id="plan-continue"
          data-plan-slug={selectedPlan ? planSlug(selectedPlan) : undefined}
          data-plan-id={selectedPlan?.id}
        >
          {(busy || continuing) && <Loader2 className="size-4 animate-spin" />}
          {continueLabel} <ArrowRight className="size-4" />
        </Button>
      </div>
    </div>
  );
}
