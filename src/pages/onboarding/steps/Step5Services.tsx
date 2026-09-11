import { useState } from "react";
import { Plus, X, ChevronDown, ChevronUp } from "lucide-react";
import { OnboardingShell, OnboardingNav } from "../OnboardingShell";
import { ONBOARDING_SPEECH } from "../messages";
import { AgentCallPreview } from "@/components/onboarding/AgentCallPreview";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useOnboardingStore } from "@/stores/useOnboardingStore";

export default function Step5Services() {
  const services = useOnboardingStore((s) => s.data.services);
  const addService = useOnboardingStore((s) => s.addService);
  const removeService = useOnboardingStore((s) => s.removeService);
  const next = useOnboardingStore((s) => s.next);
  const back = useOnboardingStore((s) => s.back);
  const [value, setValue] = useState("");
  const [error, setError] = useState("");
  // "Services I found on your website" only fits when the analyser seeded some.
  // Snapshot on mount so adding a service manually doesn't flip the message
  // (and re-speak it) mid-step — e.g. on the "I don't have a website" path.
  const [foundServices] = useState(services.length > 0);
  // Long catalogues are collapsed to the first chunk with a Show more/less toggle
  // so the list stays scannable (the analyser can return many genuine services).
  const [expanded, setExpanded] = useState(false);
  const COLLAPSED_COUNT = 12;
  const visibleServices = expanded ? services : services.slice(0, COLLAPSED_COUNT);
  const hiddenCount = services.length - COLLAPSED_COUNT;

  const handleAdd = () => {
    if (!value.trim()) return;
    addService(value);
    setValue("");
    setError("");
  };

  const handleContinue = () => {
    if (services.length === 0) {
      setError("Add at least one service to continue");
      return;
    }
    next();
  };

  return (
    <OnboardingShell
      step={5}
      onBack={back}
      message={foundServices ? ONBOARDING_SPEECH.step5 : ONBOARDING_SPEECH.step5NoServices}
      aside={<AgentCallPreview scenario="services" />}
    >
      <div className="rounded-[var(--radius-card)] border border-border bg-card p-6 shadow-[var(--shadow-soft)]">
        <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Services
        </span>

        <div className="mt-4 flex flex-wrap gap-2">
          {visibleServices.map((service, i) => (
            <span
              key={`${service}-${i}`}
              className="inline-flex items-center gap-1.5 rounded-full bg-primary-tint px-3 py-1.5 text-sm font-medium text-primary dark:text-white"
            >
              {service}
              <button
                onClick={() => removeService(i)}
                className="rounded-full p-0.5 hover:bg-primary/10"
                aria-label={`Remove ${service}`}
              >
                <X className="size-3.5" />
              </button>
            </span>
          ))}
          {services.length === 0 && (
            <p className="text-sm text-muted-foreground">No services yet — add one below.</p>
          )}
        </div>

        {services.length > COLLAPSED_COUNT && (
          <button
            type="button"
            onClick={() => setExpanded((e) => !e)}
            className="mt-3 inline-flex items-center gap-1 text-sm font-medium text-primary hover:underline"
          >
            {expanded ? (
              <>
                <ChevronUp className="size-4" /> Show less
              </>
            ) : (
              <>
                <ChevronDown className="size-4" /> Show more ({hiddenCount} more)
              </>
            )}
          </button>
        )}

        <div className="mt-5 flex items-center gap-2">
          <Input
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                handleAdd();
              }
            }}
            placeholder="Add a service"
          />
          <Button variant="outline" size="icon" onClick={handleAdd} aria-label="Add service">
            <Plus className="size-4" />
          </Button>
        </div>
        {error && <p className="mt-2 text-xs text-danger">{error}</p>}
      </div>

      <OnboardingNav>
        <Button className="w-full" onClick={handleContinue}>
          Continue
        </Button>
      </OnboardingNav>
    </OnboardingShell>
  );
}
