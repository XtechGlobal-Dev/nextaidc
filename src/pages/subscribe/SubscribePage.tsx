import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  AlertTriangle,
  ArrowLeft,
  CreditCard,
  Gift,
  LogOut,
  PhoneCall,
  ShieldCheck,
  Sparkles,
} from "lucide-react";
import { Link } from "react-router-dom";
import { toast } from "sonner";
import { BrandLogo } from "@/components/branding/BrandLogo";
import { Wordmark } from "@/components/branding/Wordmark";
import { PlanPicker, type AppliedCoupon } from "@/components/billing/PlanPicker";
import { CardForm } from "@/components/billing/CardForm";
import { api, ApiError, type SubscriptionPlan } from "@/lib/api";
import { useAuthStore } from "@/stores/useAuthStore";
import { useTrialStore } from "@/stores/useTrialStore";
import { cardWallActive } from "@/lib/cardWall";
import { formatMoney, couponDiscountCents } from "@/lib/currency";
import { cn } from "@/lib/utils";

export default function SubscribePage() {
  const navigate = useNavigate();
  const loadMe = useAuthStore((s) => s.loadMe);
  const logout = useAuthStore((s) => s.logout);
  const suspended = useAuthStore((s) => s.user?.profile?.subscriptionStatus === "suspended");
  // "Immediate" = the free trial is already used up, so subscribing charges the
  // card TODAY and activates the plan right away (no second trial). Flips all the
  // "free trial / $0 due today" copy on this page to a "charged now" narrative.
  const trial = useTrialStore((s) => s.trial);
  useEffect(() => {
    void useTrialStore.getState().hydrate();
  }, []);
  // A card-required signup that hasn't entered a card is here because it MUST be,
  // not because it chose to buy: this is the $0 authorisation that STARTS their
  // free trial. Read from the profile on the auth store, never from useTrialStore
  // — that store is persisted and hydrated asynchronously above, so `trial` is
  // null on first render and would send the wrong flag on a fast submit.
  const cardWall = useAuthStore((s) => cardWallActive(s.user));
  const immediate = Boolean(trial?.blocked) && !cardWall;
  // Everyone else reaching this page deliberately chose a plan, so confirming a
  // card is a purchase: charge and activate now rather than parking them on a
  // trial. `immediate` is separate — it means the free trial is already spent,
  // which changes the copy but no longer the outcome.
  const activateNow = !cardWall;

  // The user lands here authenticated (post-signup) and is otherwise stuck on the
  // plan wall — give them a clear way to end the session and leave.
  function handleSignOut() {
    logout();
    navigate("/login", { replace: true });
  }
  const money = formatMoney;

  const [plans, setPlans] = useState<SubscriptionPlan[] | null>(null);
  const [trialInfo, setTrialInfo] = useState<{ days: number; minutes: number } | null>(null);
  const [planId, setPlanId] = useState<string | null>(null);
  const [autoRenew, setAutoRenew] = useState(true);
  // The validated coupon, if any. PlanPicker owns the input and re-checks it
  // whenever the plan changes, so by the time it reaches here it applies. Kept
  // as the whole object, not just the code, because this page renders its own
  // totals — the "Due today" rail and the card step — and every price on screen
  // has to agree with the one in the picker.
  const [coupon, setCoupon] = useState<AppliedCoupon | null>(null);

  const [step, setStep] = useState<"select" | "pay">("select");
  const [clientSecret, setClientSecret] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Declared after trialInfo so the card-wall copy can quote the real trial length.
  const VALUE_PROPS: { icon: typeof PhoneCall; label: string }[] = [
    { icon: PhoneCall, label: "A 24/7 AI receptionist that never misses a call" },
    { icon: Sparkles, label: "Trained on your business in just a few minutes" },
    cardWall
      ? {
          icon: ShieldCheck,
          label: trialInfo?.days
            ? `$0 today — your free trial runs for ${trialInfo.days} days. Cancel anytime`
            : "$0 today — your free trial starts now. Cancel anytime",
        }
      : immediate
        ? { icon: ShieldCheck, label: "Cancel anytime — no lock-in" }
        : { icon: ShieldCheck, label: "No charge now — billed when you go live. Cancel anytime" },
  ];

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const [pl, trial] = await Promise.all([
          api.billing.plans(),
          api.billing.trialInfo().catch(() => null),
        ]);
        if (!active) return;
        setPlans(pl);
        setTrialInfo(trial);
        // Pre-select the admin-chosen default plan; fall back to the first one.
        if (pl.length) setPlanId((pl.find((p) => p.isDefault) ?? pl[0]).id);
      } catch (e) {
        toast.error(e instanceof ApiError ? e.message : "Failed to load plans");
        if (active) setPlans([]);
      }
    })();
    return () => {
      active = false;
    };
  }, []);

  const selectedPlan = useMemo(() => plans?.find((p) => p.id === planId) ?? null, [plans, planId]);
  const listPriceCents = selectedPlan?.priceCents ?? 0;
  const discountCents = couponDiscountCents(listPriceCents, coupon?.percentOff);
  const totalCents = Math.max(0, listPriceCents - discountCents);

  async function continueToPayment() {
    if (!planId) {
      toast.error("Pick a plan first");
      return;
    }
    setBusy(true);
    try {
      const { clientSecret } = await api.billing.subscribe(
        planId,
        autoRenew,
        coupon?.code ?? undefined,
      );
      if (!clientSecret) {
        toast.error("Couldn't start checkout. Is Stripe fully configured?");
        return;
      }
      setClientSecret(clientSecret);
      setStep("pay");
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "Failed to start subscription");
    } finally {
      setBusy(false);
    }
  }

  async function finish() {
    // Onboarding is fully done once the plan/trial is set up — future logins go
    // straight to the dashboard instead of resuming the funnel.
    try {
      await api.profile.onboardingProgress({ completed: true });
    } catch {
      /* best-effort — don't block reaching the dashboard */
    }
    await loadMe(); // refresh subscription status + onboarding flag
    navigate("/dashboard", { replace: true });
  }

  return (
    <div className="relative min-h-screen bg-background lg:grid lg:grid-cols-[minmax(0,400px)_1fr]">
      {/* Sign out — top-right, floats above the layout so it doesn't shift the
          vertically-centered plan content. */}
      <button
        type="button"
        onClick={handleSignOut}
        className="absolute right-4 top-4 z-20 inline-flex items-center gap-1.5 rounded-lg border border-border bg-card/80 px-3 py-1.5 text-sm font-medium text-muted-foreground backdrop-blur transition-colors hover:border-danger/40 hover:text-danger sm:right-6 sm:top-6"
        aria-label="Sign out"
      >
        <LogOut className="size-4" /> Sign out
      </button>

      {/* ---------------- Left rail ---------------- */}
      <aside className="flex flex-col border-b border-border bg-card px-6 py-6 lg:sticky lg:top-0 lg:h-screen lg:border-b-0 lg:border-r lg:px-8 lg:py-8">
        <Link to="/" className="flex items-center gap-2 font-semibold">
          <BrandLogo imgClassName="h-8 w-auto max-w-[150px] object-contain">
            <span className="flex size-8 items-center justify-center rounded-xl bg-primary text-primary-foreground shadow-sm">
              <PhoneCall className="size-4" />
            </span>
            <span>
              <Wordmark />
            </span>
          </BrandLogo>
        </Link>

        <div className="flex flex-1 flex-col justify-center py-8 lg:py-10">
          <h1 className="text-3xl font-bold leading-tight tracking-tight text-foreground">
            One last step to go live
          </h1>
          <p className="mt-3 max-w-sm text-sm text-muted-foreground">
            {cardWall
              ? "Pick a plan and add your card to start your free trial. You won't be charged today — your plan starts automatically when the trial ends."
              : immediate
                ? "Your free trial has ended. Pick a plan and add your card — you're charged today and your plan activates right away."
                : "Pick a plan and add your card — you're charged today and your plan activates right away."}
          </p>

          <ul className="mt-8 space-y-4">
            {VALUE_PROPS.map(({ icon: Icon, label }) => (
              <li key={label} className="flex items-start gap-3">
                <span className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-lg bg-primary-tint text-primary">
                  <Icon className="size-4" />
                </span>
                <span className="text-sm text-foreground/90">{label}</span>
              </li>
            ))}
          </ul>
        </div>

        {selectedPlan && (
          <div className="hidden rounded-2xl border border-border bg-background p-4 lg:block">
            <p className="text-xs uppercase tracking-wide text-muted-foreground">
              {cardWall ? "After your free trial" : "Due today"}
            </p>
            <p className="mt-1 flex items-baseline gap-1.5 text-2xl font-semibold tracking-tight text-foreground">
              {discountCents > 0 && (
                <span className="text-base font-medium text-muted-foreground line-through">
                  {money(listPriceCents, selectedPlan.currency)}
                </span>
              )}
              <span>{money(totalCents, selectedPlan.currency)}</span>
              <span className="text-sm font-normal text-muted-foreground"> / {selectedPlan.interval}</span>
            </p>
            <p className="mt-1 inline-flex items-center gap-1 text-xs font-medium text-success">
              <Gift className="size-3.5" />{" "}
              {cardWall ? "$0 today · free trial starts now" : "Charged today · plan activates now"}
            </p>
            {coupon && discountCents > 0 && (
              <p className="mt-1 text-xs text-muted-foreground">
                {coupon.code} applied ·{" "}
                {coupon.durationCycles === 1
                  ? "this charge only"
                  : `first ${coupon.durationCycles} charges`}
              </p>
            )}
          </div>
        )}
      </aside>

      {/* ---------------- Right content ---------------- */}
      <main className="flex min-h-screen flex-col items-center justify-center px-6 py-6 sm:px-10 xl:px-16">
        <div className={cn("w-full animate-in", step === "pay" ? "max-w-xl" : "max-w-5xl")}>
          {suspended && (
            <div className="mb-6 flex items-start gap-3 rounded-xl border border-danger/30 bg-danger-tint px-4 py-3 text-sm text-danger">
              <AlertTriangle className="mt-0.5 size-4 shrink-0" />
              <span>
                <strong>Account suspended.</strong> Your grace period ended and your number was
                released. Pick a plan below to reactivate — you'll be assigned a fresh number and your
                AI will be back online.
              </span>
            </div>
          )}
          <div className="mb-6 lg:hidden">
            <h2 className="text-2xl font-bold">Choose your plan</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              {cardWall
                ? "$0 today — your free trial starts as soon as your card is saved."
                : "Charged today — your plan activates right away."}
            </p>
          </div>

          {step === "select" ? (
            <PlanPicker
              plans={plans}
              trialInfo={trialInfo}
              planId={planId}
              onSelectPlan={setPlanId}
              autoRenew={autoRenew}
              onAutoRenewChange={setAutoRenew}
              onContinue={continueToPayment}
              busy={busy}
              variant="page"
              immediate={immediate}
              continueLabel={immediate ? "Pay & activate" : "Continue to payment"}
              onCouponChange={setCoupon}
              couponCode={coupon?.code ?? null}
            />
          ) : (
            /* Step 2 — card */
            <div className="rounded-[var(--radius-card)] border border-border bg-card p-6 shadow-[var(--shadow-soft)]">
              <div className="mb-4 flex items-center justify-between">
                <h2 className="flex items-center gap-2 text-base font-semibold">
                  <CreditCard className="size-5 text-primary" /> Payment details
                </h2>
                <span className="flex items-baseline gap-1.5 text-sm font-medium tabular-nums">
                  {discountCents > 0 && (
                    <span className="font-normal text-muted-foreground line-through">
                      {money(listPriceCents, selectedPlan?.currency)}
                    </span>
                  )}
                  <span>
                    {money(totalCents, selectedPlan?.currency)} / {selectedPlan?.interval}
                  </span>
                </span>
              </div>
              {coupon && discountCents > 0 && (
                <p className="-mt-2 mb-4 text-xs text-muted-foreground">
                  {coupon.code} applied —{" "}
                  {coupon.durationCycles === 1
                    ? "this charge only, then it renews at full price."
                    : `your first ${coupon.durationCycles} charges, then it renews at ${money(listPriceCents, selectedPlan?.currency)}.`}
                </p>
              )}

              <CardForm
                clientSecret={clientSecret}
                onDone={finish}
                onReject={() => {
                  setStep("select");
                  setClientSecret(null);
                }}
                activateNow={activateNow}
                plan={selectedPlan}
                context="subscribe_page"
              />

              <button
                type="button"
                onClick={() => setStep("select")}
                className="mt-4 flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
              >
                <ArrowLeft className="size-4" /> Back to plans
              </button>
            </div>
          )}
        </div>
      </main>
    </div>
  );
}
