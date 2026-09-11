import { useState } from "react";
import type { LucideIcon } from "lucide-react";
import { ArrowRight, Check, Loader2, MapPin, PhoneCall, ShieldCheck } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { OnboardingShell, OnboardingNav } from "../OnboardingShell";
import { ONBOARDING_SPEECH } from "../messages";
import { Button } from "@/components/ui/button";
import { DashboardPreview } from "@/components/onboarding/DashboardPreview";
import { useOnboardingStore } from "@/stores/useOnboardingStore";
import { useQuickSetupStore } from "@/stores/useQuickSetupStore";
import { useAuthStore } from "@/stores/useAuthStore";
import { voiceNameFor } from "@/data/voices";
import { api } from "@/lib/api";
import { cardWallActive } from "@/lib/cardWall";
import { ONBOARDING_PRICING_STEP } from "@/lib/onboardingRoute";

const FEATURES: { icon: LucideIcon; label: string }[] = [
  { icon: PhoneCall, label: "Train & test your agent" },
  { icon: ShieldCheck, label: "Deploy & stop missing calls" },
  { icon: MapPin, label: "Track every lead" },
];

function OverviewRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-4">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="font-medium text-foreground">{value}</dd>
    </div>
  );
}

export default function Step7Finish() {
  const back = useOnboardingStore((s) => s.back);
  const applyToAccount = useOnboardingStore((s) => s.applyToAccount);
  const data = useOnboardingStore((s) => s.data);
  const voiceId = useOnboardingStore((s) => s.voiceId);
  const agentName = voiceNameFor(voiceId);
  const resetSetup = useQuickSetupStore((s) => s.resetSetup);
  const navigate = useNavigate();

  const [busy, setBusy] = useState(false);

  async function handleDone() {
    setBusy(true);
    await applyToAccount(); // seeds the agent config + persists it to the DB
    resetSetup(); // so the in-dashboard Quick Setup opens fresh
    if (cardWallActive(useAuthStore.getState().user)) {
      // Card was required at signup: onboarding is NOT finished here — the plan +
      // card step still remains. Park them on the pricing step so a later login
      // resumes at the card screen instead of the dashboard. Marking it complete
      // would be untrue and would also hide them from the admin's "under
      // onboarding" list, which is exactly who support needs to chase.
      void api.profile.onboardingProgress({ step: ONBOARDING_PRICING_STEP }).catch(() => {});
      navigate("/subscribe", { replace: true });
      return;
    }
    // Card-less signup: onboarding is done here — no plan/card wall. Mark it
    // complete so future logins go straight to the dashboard. Plan + card are
    // collected later, in the "tap to set up" number wizard, only when the user
    // claims a number.
    void api.profile.onboardingProgress({ completed: true }).catch(() => {});
    toast.success("Setup complete 🎉");
    // Land the freshly-onboarded user on the AI Brain so they can review/tune
    // their assistant right away (not the empty dashboard).
    navigate("/dashboard/assistant", { replace: true });
  }

  return (
    <OnboardingShell
      step={6}
      wide
      onBack={back}
      message={ONBOARDING_SPEECH.step6}
    >
      <div className="grid gap-4 md:grid-cols-2 md:items-start">
        {/* Left: overview + what's next */}
        <div className="space-y-4">
          <div className="rounded-[var(--radius-card)] border border-border bg-card p-5 shadow-[var(--shadow-soft)]">
            <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Overview</span>
            <dl className="mt-3 space-y-2 text-sm">
              <OverviewRow label="Business" value={data.businessName || "—"} />
              <OverviewRow label="Receptionist" value={agentName} />
              <OverviewRow label="Services" value={data.services.length ? `${data.services.length} added` : "—"} />
              {data.phone && <OverviewRow label="Business number" value={data.phone} />}
              {data.address && <OverviewRow label="Address" value={data.address} />}
            </dl>
          </div>

          <div className="grid gap-2">
            {FEATURES.map(({ icon: Icon, label }) => (
              <div
                key={label}
                className="flex items-center gap-3 rounded-[var(--radius-card)] border border-border bg-card p-3 shadow-[var(--shadow-soft)]"
              >
                <span className="flex size-8 items-center justify-center rounded-xl bg-primary-tint text-primary">
                  <Icon className="size-4" />
                </span>
                <span className="text-sm font-medium text-foreground">{label}</span>
              </div>
            ))}
          </div>
        </div>

        {/* Right: dashboard preview */}
        <div>
          <DashboardPreview />
          <p className="mt-2 text-center text-xs font-medium text-muted-foreground">A peek at your dashboard</p>
        </div>
      </div>

      <OnboardingNav>
        <Button className="w-full" onClick={handleDone} disabled={busy}>
          {busy ? <Loader2 className="size-4 animate-spin" /> : <Check className="size-4" />}
          Done <ArrowRight className="size-4" />
        </Button>
      </OnboardingNav>
    </OnboardingShell>
  );
}
