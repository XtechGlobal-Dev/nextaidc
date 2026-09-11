import { useMemo, useState } from "react";
import { Elements, PaymentElement, useElements, useStripe } from "@stripe/react-stripe-js";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { stripePromise } from "@/lib/stripe";
import { api, ApiError } from "@/lib/api";
import { trackEvent, type FunnelContext } from "@/lib/analytics";
import { planAnalyticsParams, type PlanIdentity } from "@/lib/planSlug";
import { useUiStore } from "@/stores/useUiStore";

/** The analytics-only props, shared by the inner form and the exported wrapper. */
interface CardAnalyticsProps {
  /** The plan being paid for, so the `card_added` event names it. Optional —
   *  the event still fires without it, just without the plan dimensions. */
  plan?: PlanIdentity | null;
  /** Which funnel this card step belongs to. */
  context?: FunnelContext;
}

interface PaymentFormProps extends CardAnalyticsProps {
  onDone: () => void;
  onReject: () => void;
  submitLabel?: string;
  /** The user deliberately bought a plan, so charge and activate on confirm.
   *  Every caller does this today; the flag stays explicit so a future
   *  store-a-card-only flow can opt out without changing the default. */
  activateNow?: boolean;
}

function PaymentForm({
  onDone,
  onReject,
  submitLabel,
  activateNow = false,
  plan,
  context,
}: PaymentFormProps) {
  const stripe = useStripe();
  const elements = useElements();
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!stripe || !elements) return;
    setBusy(true);
    const { error, setupIntent } = await stripe.confirmSetup({ elements, redirect: "if_required" });
    if (error) {
      toast.error(error.message ?? "Could not save your card");
      setBusy(false);
      return;
    }

    // Confirm the saved card belongs to this account. Card uniqueness is no longer
    // enforced (the same card may fund multiple accounts — sign-up is gated by a
    // unique mobile number instead), so this only rejects a genuinely bad method.
    const pmId =
      typeof setupIntent?.payment_method === "string"
        ? setupIntent.payment_method
        : setupIntent?.payment_method?.id;
    // No payment method id means the SetupIntent didn't give us a card to confirm,
    // so nothing was activated server-side. This used to fall through to the
    // success toast — the user was told their plan was live when the server had
    // never been told anything at all.
    if (!pmId) {
      toast.error("We couldn't read your card details. Please try again.");
      setBusy(false);
      return;
    }

    // The server is the only thing that knows whether the card was actually
    // billed, so the toast follows its answer — it can never claim a trial
    // started when the user was in fact charged, or vice versa.
    let charged: boolean;
    try {
      const res = await api.billing.confirmCard(pmId, activateNow);
      charged = res.charged;
    } catch (err) {
      toast.error(
        err instanceof ApiError ? err.message : "Could not verify your card. Please try another.",
      );
      setBusy(false);
      // A declined charge leaves the subscription untouched server-side, so the
      // user can simply enter another card here. Only bounce them back to the
      // start when there's no usable subscription to retry against.
      if (!activateNow) onReject();
      return;
    }

    // A named event for "the card was accepted", rather than leaning on GTM's
    // generic `gtm.formSubmit` auto event. That one fires the moment ANY form on
    // the page is submitted — including a card that goes on to be declined — so
    // it over-counts and can't be told apart from other forms. This fires once,
    // only after Stripe confirmed the card AND the server accepted it.
    trackEvent("card_added", {
      ...(plan ? planAnalyticsParams(plan) : {}),
      plan_context: context,
      // true = the card was charged and the plan is live; false = card stored only.
      charged,
    });

    // Never claims a trial "started": the free trial begins at signup (see the
    // card-less trial branch in getEntitlement), so saying it starts here — after
    // the user picked a plan and entered a card — was both wrong and confusing.
    toast.success(charged ? "Payment successful — your plan is active 🎉" : "Card saved 🎉");
    onDone();
  }

  return (
    <form onSubmit={submit} className="space-y-4">
      <PaymentElement options={{ wallets: { link: "never", applePay: "never", googlePay: "never" } }} />
      <Button type="submit" className="w-full" disabled={!stripe || busy}>
        {busy && <Loader2 className="size-4 animate-spin" />}
        {submitLabel ?? (activateNow ? "Pay & activate" : "Save card & start free trial")}
      </Button>
      <p className="text-center text-xs text-muted-foreground">
        {activateNow
          ? "Your card is charged today and your plan activates immediately. Cancel anytime."
          : "Saved securely — $0 today. You're only charged when your free trial ends. Cancel anytime."}
      </p>
    </form>
  );
}

export interface CardFormProps extends CardAnalyticsProps {
  /** SetupIntent client secret from api.billing.subscribe(); null = still loading. */
  clientSecret: string | null;
  onDone: () => void;
  onReject: () => void;
  submitLabel?: string;
  /** The user deliberately bought a plan — charge and activate on confirm. */
  activateNow?: boolean;
}

/**
 * The card-collection step, shared by the /subscribe page and the in-dashboard
 * number-setup wizard. Wraps Stripe Elements around the SetupIntent, confirms the
 * card, and enforces the one-card-per-account rule. The parent starts the
 * subscription (to get `clientSecret`) and decides what happens on done/reject.
 */
export function CardForm({
  clientSecret,
  onDone,
  onReject,
  submitLabel,
  activateNow = false,
  plan,
  context,
}: CardFormProps) {
  const themeMode = useUiStore((s) => s.themeMode);
  const isDark = useMemo(
    () => typeof document !== "undefined" && document.documentElement.classList.contains("dark"),
    [themeMode],
  );

  if (!stripePromise) {
    return (
      <p className="rounded-lg bg-muted p-3 text-sm text-muted-foreground">
        Stripe publishable key isn't configured. Set <code>VITE_STRIPE_PUBLISHABLE_KEY</code> in your
        frontend <code>.env</code> and restart to collect cards.
      </p>
    );
  }

  if (!clientSecret) {
    return (
      <div className="flex justify-center py-10 text-muted-foreground">
        <Loader2 className="size-6 animate-spin" />
      </div>
    );
  }

  return (
    <Elements
      stripe={stripePromise}
      options={{ clientSecret, appearance: { theme: isDark ? "night" : "stripe" } }}
    >
      <PaymentForm
        onDone={onDone}
        onReject={onReject}
        submitLabel={submitLabel}
        activateNow={activateNow}
        plan={plan}
        context={context}
      />
    </Elements>
  );
}
