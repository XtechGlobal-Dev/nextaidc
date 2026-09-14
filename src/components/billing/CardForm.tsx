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
  /** Charge and activate on confirm. Kept explicit so a future store-card-only flow can opt out. */
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

    // Card uniqueness isn't enforced any more (sign-up is gated by mobile number), so this only rejects a bad method.
    const pmId =
      typeof setupIntent?.payment_method === "string"
        ? setupIntent.payment_method
        : setupIntent?.payment_method?.id;
    // No pm id = nothing activated server-side. This used to fall through to the success toast.
    if (!pmId) {
      toast.error("We couldn't read your card details. Please try again.");
      setBusy(false);
      return;
    }

    // Only the server knows whether the card was billed, so the toast follows its answer.
    let charged: boolean;
    try {
      const res = await api.billing.confirmCard(pmId, activateNow);
      charged = res.charged;
    } catch (err) {
      toast.error(
        err instanceof ApiError ? err.message : "Could not verify your card. Please try another.",
      );
      setBusy(false);
      // A declined charge leaves the subscription intact, so only bounce when there's nothing to retry against.
      if (!activateNow) onReject();
      return;
    }

    // Named event instead of GTM's `gtm.formSubmit`, which fires for any form (declined cards included).
    // Fires once, only after Stripe and the server both accepted.
    trackEvent("card_added", {
      ...(plan ? planAnalyticsParams(plan) : {}),
      plan_context: context,
      // true = the card was charged and the plan is live; false = card stored only.
      charged,
    });

    // Never say a trial "started" here; the trial begins at signup (see getEntitlement).
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

/** Card-collection step around a Stripe SetupIntent. Parent starts the subscription (for `clientSecret`) and owns done/reject. */
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
