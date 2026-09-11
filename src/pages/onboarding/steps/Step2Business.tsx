import { useState } from "react";
import { Check, Pencil } from "lucide-react";
import { OnboardingShell, OnboardingNav } from "../OnboardingShell";
import { ONBOARDING_SPEECH } from "../messages";
import { AgentCallPreview } from "@/components/onboarding/AgentCallPreview";
import { Button } from "@/components/ui/button";
import { Input, Textarea } from "@/components/ui/input";
import { NAME_MAX, clampName } from "@/lib/limits";
import { useOnboardingStore } from "@/stores/useOnboardingStore";

export default function Step2Business() {
  const businessName = useOnboardingStore((s) => s.data.businessName);
  const businessDescription = useOnboardingStore((s) => s.data.businessDescription);
  const updateData = useOnboardingStore((s) => s.updateData);
  const next = useOnboardingStore((s) => s.next);
  const back = useOnboardingStore((s) => s.back);
  const skippedWebsite = useOnboardingStore((s) => s.skippedWebsite);
  const editWebsite = useOnboardingStore((s) => s.editWebsite);
  const hasDetails = businessName.trim() !== "" && businessDescription.trim() !== "";
  const descriptionValid = businessDescription.trim() !== "";
  // Open the editor when something's still missing.
  const [editing, setEditing] = useState(!hasDetails);
  const canContinue = businessName.trim() !== "" && descriptionValid;

  return (
    <OnboardingShell
      step={2}
      onBack={skippedWebsite ? editWebsite : back}
      message={hasDetails ? ONBOARDING_SPEECH.step2HasDetails : ONBOARDING_SPEECH.step2NoDetails}
      aside={<AgentCallPreview scenario="intro" />}
    >
      <div className="rounded-[var(--radius-card)] border border-border bg-card p-6 shadow-[var(--shadow-soft)]">
        <div className="flex items-start justify-between">
          <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Business details
          </span>
          {hasDetails && (
            <button
              onClick={() => setEditing((e) => !e)}
              className="inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline"
              aria-label={editing ? "Done editing" : "Edit business details"}
            >
              {editing ? (
                "Done"
              ) : (
                <>
                  <Pencil className="size-3.5" /> Edit
                </>
              )}
            </button>
          )}
        </div>

        {editing ? (
          <div className="mt-4 space-y-3">
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-muted-foreground">Business name *</label>
              <Input
                value={businessName}
                maxLength={NAME_MAX}
                onChange={(e) => updateData({ businessName: clampName(e.target.value) })}
                placeholder="Business name"
              />
            </div>
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-muted-foreground">Description *</label>
              <Textarea
                value={businessDescription}
                onChange={(e) => updateData({ businessDescription: e.target.value })}
                placeholder="Describe what your business does, the services you offer, and what customers usually call about, so I can answer calls accurately."
                rows={5}
                aria-invalid={!descriptionValid}
              />
            </div>
          </div>
        ) : (
          <div className="mt-4">
            <h2 className="text-2xl font-bold leading-tight">{businessName}</h2>
            <p className="mt-2 text-sm text-muted-foreground">{businessDescription}</p>
          </div>
        )}
      </div>

      <OnboardingNav>
        <Button className="w-full" onClick={() => next()} disabled={!canContinue}>
          <Check className="size-4" /> {hasDetails ? "Yes, that's correct" : "Continue"}
        </Button>
      </OnboardingNav>
    </OnboardingShell>
  );
}
