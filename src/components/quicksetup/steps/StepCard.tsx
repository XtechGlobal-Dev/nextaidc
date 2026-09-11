import { CreditCard } from "lucide-react";
import { CardForm } from "@/components/billing/CardForm";
import { useQuickSetupStore, QUICK_SETUP_NUMBER_STEP } from "@/stores/useQuickSetupStore";
import { useAuthStore } from "@/stores/useAuthStore";

/**
 * Quick-setup payment step — the card is charged here and the plan activates.
 *
 * It used to only STORE the card, deferring the charge to the number step. That
 * left the user told "your free trial has started" after they had deliberately
 * picked a plan and entered a card — and their trial had in fact started at
 * signup, days earlier. Picking a plan and paying now does what it says.
 *
 * The number step's charge is untouched and stays as a safety net: it only fires
 * for a still-"trialing" profile, so once this step activates the plan it is a
 * no-op there and nobody is billed twice.
 */
export default function StepCard() {
  const clientSecret = useQuickSetupStore((s) => s.billingClientSecret);
  const setBillingClientSecret = useQuickSetupStore((s) => s.setBillingClientSecret);
  const plan = useQuickSetupStore((s) => s.billingPlan);
  const setBillingPlan = useQuickSetupStore((s) => s.setBillingPlan);
  const goTo = useQuickSetupStore((s) => s.goTo);
  const loadMe = useAuthStore((s) => s.loadMe);

  async function handleDone() {
    // Refresh the profile so subscriptionStatus flips to "active" — the number
    // step + Go Live depend on it. Jump to the Number step by ABSOLUTE index (not
    // next()): loadMe flips hasBilling mid-render, which fires the "skip billing"
    // effect (step 4 → 5); a relative next() would then over-shoot 5 → 6 (Go Live)
    // and skip number selection. goTo is idempotent with that effect.
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
