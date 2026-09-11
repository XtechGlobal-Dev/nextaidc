import { useEffect, useState } from "react";
import { toast } from "sonner";
import { PlanPicker, type AppliedCoupon } from "@/components/billing/PlanPicker";
import { useQuickSetupStore } from "@/stores/useQuickSetupStore";
import { useTrialStore } from "@/stores/useTrialStore";
import { api, ApiError, type SubscriptionPlan } from "@/lib/api";

/**
 * Quick-setup step 3 — pick a plan and start the free trial. Gating the number
 * step: a customer tests web calls freely, but claiming a dedicated number needs
 * a plan + card. Selecting a plan starts a subscription (SetupIntent) whose secret
 * is handed to the Payment step (step 4).
 */
export default function StepPlan() {
  const next = useQuickSetupStore((s) => s.next);
  const setBillingClientSecret = useQuickSetupStore((s) => s.setBillingClientSecret);
  const setBillingPlan = useQuickSetupStore((s) => s.setBillingPlan);
  // Free trial used up → subscribing charges the card today (no second trial).
  const immediate = useTrialStore((s) => Boolean(s.trial?.blocked));

  const [plans, setPlans] = useState<SubscriptionPlan[] | null>(null);
  const [trialInfo, setTrialInfo] = useState<{ days: number; minutes: number } | null>(null);
  const [planId, setPlanId] = useState<string | null>(null);
  const [autoRenew, setAutoRenew] = useState(true);
  // The validated coupon, kept whole so the code can be sent to /subscribe and
  // survive a trip to the payment step and back.
  const [coupon, setCoupon] = useState<AppliedCoupon | null>(null);
  const [busy, setBusy] = useState(false);

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
      setBillingClientSecret(clientSecret);
      // Hand the chosen plan to the Payment step so its `card_added` event can
      // name it — the shared CardForm has no other way to know.
      setBillingPlan(plans?.find((p) => p.id === planId) ?? null);
      next(); // → Payment step
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "Failed to start subscription");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-5">
      <div className="text-center">
        <h2 className="text-2xl font-bold">Choose your plan</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          {immediate
            ? "Your free trial has ended — pick a plan to unlock your dedicated AI number. Charged today."
            : "Pick your plan. You're charged on the next step and your plan activates right away."}
        </p>
      </div>
      <PlanPicker
        plans={plans}
        trialInfo={trialInfo}
        planId={planId}
        onSelectPlan={setPlanId}
        autoRenew={autoRenew}
        onAutoRenewChange={setAutoRenew}
        onContinue={continueToPayment}
        busy={busy}
        variant="modal"
        immediate={immediate}
        continueLabel={immediate ? "Pay & activate" : "Continue to payment"}
        onCouponChange={setCoupon}
        couponCode={coupon?.code ?? null}
      />
    </div>
  );
}
