import { useEffect } from "react";
import { Phone, Rocket, Gift, CreditCard, Check, X } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { useBodyScrollLock } from "@/hooks/useBodyScrollLock";
import { useProfileStore } from "@/stores/useProfileStore";
import { useAuthStore } from "@/stores/useAuthStore";
import { useQuickSetupStore, QUICK_SETUP_STEPS, QUICK_SETUP_NUMBER_STEP } from "@/stores/useQuickSetupStore";
import StepPlan from "./steps/StepPlan";
import StepCard from "./steps/StepCard";
import Step3Number from "./steps/Step3Number";
import Step4GoLive from "./steps/Step4GoLive";

interface StepMeta {
  n: number;
  label: string;
  blurb: string;
  icon: LucideIcon;
  colorVar: string;
}

// 4-step flow. Steps 1-2 (Plan → Payment) gate number assignment and are shown as
// completed (✓) for users who already have a live subscription (card on file).
const ALL_STEPS: StepMeta[] = [
  { n: 1, label: "Choose Plan", blurb: "Pick your plan", icon: Gift, colorVar: "--color-step-1" },
  { n: 2, label: "Payment", blurb: "Pay & activate your plan", icon: CreditCard, colorVar: "--color-step-2" },
  { n: 3, label: "Your Number", blurb: "Claim a phone number", icon: Phone, colorVar: "--color-step-3" },
  { n: 4, label: "Go Live", blurb: "Launch your receptionist", icon: Rocket, colorVar: "--color-step-4" },
];

export function QuickSetupModal() {
  const open = useQuickSetupStore((s) => s.open);
  const step = useQuickSetupStore((s) => s.step);
  const goTo = useQuickSetupStore((s) => s.goTo);
  const close = useQuickSetupStore((s) => s.close);
  const assistantName = useProfileStore((s) => s.profile.businessName) || "your receptionist";
  const role = useAuthStore((s) => s.user?.role);
  const hasNumber = useProfileStore((s) => Boolean(s.profile.receptionistNumber?.trim()));
  // "Has plan + card" — a live subscription. These users skip the Plan/Payment
  // steps; everyone else must complete them before claiming a number.
  const subscriptionStatus = useAuthStore((s) => s.user?.profile?.subscriptionStatus);
  const hasBilling =
    subscriptionStatus === "trialing" ||
    subscriptionStatus === "active" ||
    subscriptionStatus === "past_due";
  const needsBilling = !hasBilling;

  // This is the CUSTOMER onboarding wizard (claim a number → go live). Admins and
  // resellers are never onboarded this way — they configure the platform globally
  // and have no number to claim (and on a fresh install nothing is even wired up,
  // so a Vapi assistant / Twilio number can't be provisioned). So it only ever
  // shows for the customer ("USER") role.
  const isCustomer = role === "USER";

  // Claiming a number is OPTIONAL — the wizard is opened manually from the sidebar
  // and can always be skipped/closed. Kept as a flag so the close/skip stay wired.
  const lockedUntilNumber = false;

  // Always show all six steps; the Plan + Payment steps render as completed (✓)
  // once the user has subscribed, rather than vanishing — a steadier, clearer rail.
  const steps = ALL_STEPS;
  const totalSteps = steps.length;
  const currentIndex = Math.max(
    steps.findIndex((s) => s.n === step),
    0,
  );

  // The number-setup wizard never auto-opens — it opens ONLY when the user clicks
  // "Tap to set up" in the sidebar (which calls openSetup). Claiming a number is
  // optional; nothing pops it up on its own.

  // Already subscribed but no number yet → their only remaining task is claiming a
  // number, so land them there (Plan/Payment show as done). This also carries the
  // Card step forward the moment billing completes, and keeps a subscribed user
  // from ever sitting on the billing steps.
  useEffect(() => {
    if (open && hasBilling && !hasNumber && step < QUICK_SETUP_NUMBER_STEP)
      goTo(QUICK_SETUP_NUMBER_STEP);
  }, [open, hasBilling, hasNumber, step, goTo]);

  // A number is already assigned → the number step (incl. paid buy) is done. Pin
  // the wizard to the final step so a refresh can't drop the user back onto the
  // picker and have them buy a second number.
  useEffect(() => {
    if (hasNumber && open && step < QUICK_SETUP_STEPS) goTo(QUICK_SETUP_STEPS);
  }, [hasNumber, open, step, goTo]);

  // Freeze background scroll while the wizard is up.
  useBodyScrollLock(open && isCustomer);

  // Never render for admins/resellers, even if a persisted `open` flag lingers.
  if (!open || !isCustomer) return null;

  const donePct = Math.round((currentIndex / totalSteps) * 100);
  // The plan step shows three plan cards side by side — give it more room so they
  // don't get cramped; the other steps stay at the comfortable narrower width.
  const wideStep = needsBilling && step === 1;

  return (
    <div className="fixed inset-0 z-[1001] flex items-center justify-center bg-foreground/40 p-4 backdrop-blur-sm">
      <div
        className={cn(
          "flex max-h-[92vh] w-full flex-col overflow-hidden rounded-2xl border border-border bg-background shadow-[var(--shadow-panel)] transition-[max-width] duration-300",
          wideStep ? "max-w-6xl" : "max-w-3xl",
        )}
      >
        {/* Header */}
        <header className="flex items-center justify-between gap-3 border-b border-border px-6 py-4">
          <div className="flex items-center gap-3">
            <div className="grid size-10 place-items-center rounded-xl bg-gradient-to-br from-primary to-[#1d4ed8] text-white shadow-[var(--shadow-soft)]">
              <Rocket className="size-5" />
            </div>
            <div>
              <h2 className="text-base font-bold leading-tight">Get your AI receptionist live</h2>
              <p className="text-sm text-muted-foreground">A few quick steps to launch {assistantName}.</p>
            </div>
          </div>
          {/* No close button until a number is claimed — the wizard can't be
              dismissed without finishing number setup. */}
          {!lockedUntilNumber && (
            <button
              onClick={close}
              className="grid size-8 shrink-0 place-items-center rounded-full text-muted-foreground hover:bg-muted hover:text-foreground"
              aria-label="Close"
            >
              <X className="size-4" />
            </button>
          )}
        </header>

        {/* Body: stepper rail + canvas */}
        <div className="grid min-h-0 flex-1 overflow-hidden md:grid-cols-[224px_minmax(0,1fr)]">
          {/* Rail (desktop) */}
          <aside className="hidden flex-col justify-between border-r border-border bg-warm/40 p-3 md:flex">
            <nav className="relative flex flex-col gap-1">
              <span className="pointer-events-none absolute left-[27px] top-7 bottom-7 w-px bg-border" />
              {steps.map((s, i) => {
                const active = step === s.n;
                // Plan + Payment show as completed (✓) once the user has subscribed.
                const done = step > s.n || (hasBilling && (s.n === 1 || s.n === 2));
                return (
                  <div
                    key={s.n}
                    className={cn(
                      "relative flex items-center gap-3 rounded-xl px-3 py-2.5",
                      active && "bg-card shadow-[var(--shadow-soft)]",
                    )}
                  >
                    <span
                      className={cn(
                        "relative z-10 grid size-8 shrink-0 place-items-center rounded-full text-xs font-bold ring-4 ring-warm transition-colors",
                        active || done ? "text-white" : "bg-muted-foreground/15 text-muted-foreground",
                      )}
                      style={active || done ? { backgroundColor: `var(${s.colorVar})` } : undefined}
                    >
                      {done ? <Check className="size-4" /> : i + 1}
                    </span>
                    <span className="min-w-0">
                      <span
                        className={cn(
                          "block text-sm font-semibold leading-tight",
                          active ? "text-foreground" : "text-foreground/80",
                        )}
                      >
                        {s.label}
                      </span>
                      <span className="block truncate text-xs text-muted-foreground">{s.blurb}</span>
                    </span>
                  </div>
                );
              })}
            </nav>

            <div className="mt-3 rounded-xl border border-border bg-card p-3">
              <div className="flex items-center justify-between text-xs">
                <span className="font-medium text-foreground/80">Setup progress</span>
                <span className="font-semibold text-primary">{donePct}%</span>
              </div>
              <div className="mt-2 h-2 overflow-hidden rounded-full bg-muted">
                <div
                  className="h-full rounded-full bg-gradient-to-r from-primary to-[#1d4ed8] transition-[width] duration-500"
                  style={{ width: `${donePct}%` }}
                />
              </div>
            </div>
          </aside>

          {/* Canvas */}
          <section className="flex min-h-0 flex-col overflow-y-auto">
            {/* Mobile step indicator */}
            <div className="flex items-center gap-1.5 border-b border-border px-6 py-3 text-xs font-medium text-muted-foreground md:hidden">
              Step {currentIndex + 1} of {totalSteps} · {steps[currentIndex]?.label}
            </div>
            <div className="p-6">
              {needsBilling && step === 1 && <StepPlan />}
              {needsBilling && step === 2 && <StepCard />}
              {step === 3 && <Step3Number />}
              {step === 4 && <Step4GoLive />}
            </div>

            {/* Skip is only offered while a number isn't required yet — the wizard
                still can't be dismissed without finishing number setup. */}
            {!lockedUntilNumber && (
              <div className="mt-auto flex justify-end border-t border-border px-6 py-3">
                <button
                  onClick={close}
                  className="text-sm font-medium text-muted-foreground hover:text-foreground hover:underline"
                >
                  Skip for now
                </button>
              </div>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}
