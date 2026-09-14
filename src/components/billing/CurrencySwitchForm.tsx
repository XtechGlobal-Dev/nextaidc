import { useMemo, useState } from "react";
import { Elements, PaymentElement, useElements, useStripe } from "@stripe/react-stripe-js";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { stripePromise } from "@/lib/stripe";
import { api, ApiError } from "@/lib/api";
import { useUiStore } from "@/stores/useUiStore";

// Cross-currency switch card step. Uses a PaymentIntent (pays the first invoice up front) unlike CardForm's
// SetupIntent; the old subscription is only cancelled after payment lands. A new card is unavoidable:
// Stripe locks a customer to one currency, so the switch runs on a new customer and cards can't move.
function SwitchPaymentForm({
  onDone,
  onCancel,
  priceLabel,
}: {
  onDone: () => void;
  onCancel: () => void;
  priceLabel: string;
}) {
  const stripe = useStripe();
  const elements = useElements();
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!stripe || !elements) return;
    setBusy(true);

    const { error } = await stripe.confirmPayment({ elements, redirect: "if_required" });
    if (error) {
      // Nothing to roll back: the old subscription is still live and still the
      // one on record, so a declined card costs the customer nothing.
      toast.error(error.message ?? "That payment didn't go through. Your current plan is unchanged.");
      setBusy(false);
      return;
    }

    // Payment succeeded — tell the server, which re-checks with Stripe before it
    // cancels the old subscription. It never takes the client's word for it.
    try {
      const res = await api.billing.switchCurrencyConfirm();
      toast.success(`You're now on ${res.planName} 🎉`);
      onDone();
    } catch (err) {
      // The charge went through but the handover didn't. Say so plainly rather
      // than showing a generic failure — support needs to know money moved.
      toast.error(
        err instanceof ApiError
          ? err.message
          : "Your payment went through but we couldn't finish the switch. Please contact support.",
      );
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="space-y-4">
      <PaymentElement options={{ wallets: { link: "never", applePay: "never", googlePay: "never" } }} />
      <div className="flex gap-2">
        <Button type="button" variant="outline" className="flex-1" onClick={onCancel} disabled={busy}>
          Cancel
        </Button>
        <Button type="submit" className="flex-1" disabled={!stripe || busy}>
          {busy && <Loader2 className="size-4 animate-spin" />}
          Pay {priceLabel}
        </Button>
      </div>
      <p className="text-center text-xs text-muted-foreground">
        Your current plan stays active until this payment succeeds.
      </p>
    </form>
  );
}

export function CurrencySwitchForm({
  clientSecret,
  priceLabel,
  onDone,
  onCancel,
}: {
  /** PaymentIntent secret from switch-currency/start; null = still loading. */
  clientSecret: string | null;
  priceLabel: string;
  onDone: () => void;
  onCancel: () => void;
}) {
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
      <SwitchPaymentForm onDone={onDone} onCancel={onCancel} priceLabel={priceLabel} />
    </Elements>
  );
}
