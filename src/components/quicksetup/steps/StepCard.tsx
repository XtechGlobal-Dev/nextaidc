import { CreditCard } from "lucide-react";
import { CardForm } from "@/components/billing/CardForm";
import { useQuickSetupStore, QUICK_SETUP_NUMBER_STEP } from "@/stores/useQuickSetupStore";
import { useAuthStore } from "@/stores/useAuthStore";

/** Quick-setup payment step: charges the card and activates the plan here. The number step's charge stays
 *  as a safety net; it only fires for a still-trialing profile, so nobody is billed twice. */
export default function StepCard() {
  const clientSecret = useQuickSetupStore((s) => s.billingClientSecret);
  const setBillingClientSecret = useQuickSetupStore((s) => s.setBillingClientSecret);
  const plan = useQuickSetupStore((s) => s.billingPlan);
  const setBillingPlan = useQuickSetupStore((s) => s.setBillingPlan);
  const goTo = useQuickSetupStore((s) => s.goTo);
  const loadMe = useAuthStore((s) => s.loadMe);

  async function handleDone() {
    // Refresh so subscriptionStatus flips to active, then jump by absolute index: loadMe fires the
    // "skip billing" effect, and a relative next() would overshoot past number selection.
    await loadMe().catch(() => {});
    goTo(QUICK_SETUP_NUMBER_STEP); // → Your Number
  }

  return (
    <div className="mx-auto max-w-xl space-y-4">
      <div className="text-center">
        <h2 className="flex items-center justify-center gap-2 text-2xl font-bold">
          <CreditCard className="size-6 text-primary" /> Payment
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Your card is charged today and your plan activates immediately. Cancel anytime.
        </p>
      </div>

      <div className="rounded-[var(--radius-card)] border border-border bg-card p-6 shadow-[var(--shadow-soft)]">
        <CardForm
          clientSecret={clientSecret}
          onDone={handleDone}
          activateNow
          plan={plan}
          context="quick_setup"
          onReject={() => {
            // Clear the stale secret and send them back to re-pick a plan (step 1,
            // which mints a fresh SetupIntent).
            setBillingClientSecret(null);
            setBillingPlan(null);
            goTo(1);
          }}
        />
      </div>
    </div>
  );
}
