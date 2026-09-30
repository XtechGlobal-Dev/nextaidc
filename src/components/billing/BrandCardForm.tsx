import { useEffect, useMemo, useState } from "react";
import { Elements, PaymentElement, useElements, useStripe } from "@stripe/react-stripe-js";
import { Loader2, Lock } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { stripePromise } from "@/lib/stripe";
import { api, ApiError } from "@/lib/api";
import { useUiStore } from "@/stores/useUiStore";

// Card entry for a brand paying the PLATFORM. Same SetupIntent + PaymentElement flow as a customer's
// card (components/billing/CardForm.tsx), but it confirms against the brand's own billing endpoints and
// hands the confirmed card to `onConfirmed`, which charges it.

function Inner({
  submitLabel,
  note,
  onConfirmed,
}: {
  submitLabel: string;
  note: string;
  onConfirmed: (paymentMethodId: string, setupIntentId: string) => Promise<void>;
}) {
  const stripe = useStripe();
  const elements = useElements();
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    // Rendered in a portal, but React still bubbles the submit up the component tree — a page form
    // around the dialog would take it as its own submit.
    e.stopPropagation();
    if (!stripe || !elements) return;
    setBusy(true);
    try {
      const { error, setupIntent } = await stripe.confirmSetup({ elements, redirect: "if_required" });
      if (error) {
        toast.error(error.message ?? "Could not save the card");
        return;
      }
      const pm = setupIntent?.payment_method;
      const pmId = typeof pm === "string" ? pm : pm?.id;
      if (!pmId) {
        toast.error("We couldn't read the card details. Please try again.");
        return;
      }
      await onConfirmed(pmId, setupIntent?.id ?? "");
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "The payment didn't go through.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="space-y-4">
      <PaymentElement options={{ wallets: { link: "never", applePay: "never", googlePay: "never" } }} />
      <Button type="submit" className="w-full" disabled={!stripe || busy}>
        {busy ? <Loader2 className="size-4 animate-spin" /> : <Lock className="size-4" />}
        {submitLabel}
      </Button>
      <p className="text-center text-xs text-muted-foreground">{note}</p>
    </form>
  );
}

export function BrandCardForm({
  submitLabel,
  note,
  onConfirmed,
  createIntent = api.brandAdmin.billing.setupIntent,
}: {
  submitLabel: string;
  note: string;
  onConfirmed: (paymentMethodId: string, setupIntentId: string) => Promise<void>;
  /** Where the SetupIntent comes from — the brand admin's billing by default; the public request form
   *  passes its own. */
  createIntent?: () => Promise<{ clientSecret: string }>;
}) {
  const themeMode = useUiStore((s) => s.themeMode);
  const isDark = useMemo(
    () => typeof document !== "undefined" && document.documentElement.classList.contains("dark"),
    [themeMode],
  );
  const [clientSecret, setClientSecret] = useState<string | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    let active = true;
    createIntent()
      .then((r) => active && setClientSecret(r.clientSecret))
      .catch((e) => active && setError(e instanceof ApiError ? e.message : "Couldn't start card setup."));
    return () => {
      active = false;
    };
    // Once per mount: a new intent per render would re-mount Stripe's form under the typist.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!stripePromise) {
    return (
      <p className="rounded-lg bg-muted p-3 text-sm text-muted-foreground">
        Card payments aren&rsquo;t available yet — the Stripe publishable key isn&rsquo;t configured.
      </p>
    );
  }
  if (error) return <p className="rounded-lg bg-danger-tint p-3 text-sm text-danger">{error}</p>;
  if (!clientSecret) {
    return (
      <div className="flex justify-center py-10 text-muted-foreground">
        <Loader2 className="size-6 animate-spin" />
      </div>
    );
  }
  return (
    <Elements stripe={stripePromise} options={{ clientSecret, appearance: { theme: isDark ? "night" : "stripe" } }}>
      <Inner submitLabel={submitLabel} note={note} onConfirmed={onConfirmed} />
    </Elements>
  );
}
