import { useEffect, useState } from "react";
import { Volume2, ArrowRight, Check, Keyboard } from "lucide-react";
import { OnboardingShell, OnboardingNav } from "./OnboardingShell";
import { Button } from "@/components/ui/button";
import { Input, Textarea } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { speak, stopSpeaking, prefetchSpeech, ttsSupported } from "@/lib/speech";
import { useOnboardingStore, type OnboardingData } from "@/stores/useOnboardingStore";

/* ------------------------------------------------------------------ *
 *  VoiceSetup — Emma *speaks* each question (text-to-speech) and the
 *  user *types* the answer. A friendly, guided alternative to filling
 *  the manual onboarding forms.
 * ------------------------------------------------------------------ */

type FieldKey = "businessName" | "businessDescription" | "services" | "phone" | "email";

interface Question {
  key: FieldKey;
  question: string; // spoken aloud + shown in the AI bubble
  label: string;
  placeholder: string;
  multiline?: boolean;
}

const QUESTIONS: Question[] = [
  {
    key: "businessName",
    question: "Let's set you up by voice. First — what's the name of your business?",
    label: "Business name",
    placeholder: "e.g. Max Plumbing",
  },
  {
    key: "businessDescription",
    question: "Great. In a sentence, what does your business do?",
    label: "What your business does",
    placeholder: "What you do and who you help…",
    multiline: true,
  },
  {
    key: "services",
    question: "What are the main services you offer? Separate them with commas.",
    label: "Services (comma separated)",
    placeholder: "Repairs, Quotes, Bookings",
  },
  {
    key: "phone",
    question: "What's the best phone number for customers to reach you?",
    label: "Contact phone",
    placeholder: "e.g. 0400 000 000",
  },
  {
    key: "email",
    question: "And finally, what's your contact email?",
    label: "Contact email",
    placeholder: "name@business.com",
  },
];

/** Read the current stored value for a question, formatted for the input. */
function valueFor(key: FieldKey, data: OnboardingData): string {
  if (key === "services") return data.services.join(", ");
  return data[key] ?? "";
}

export default function VoiceSetup() {
  const updateData = useOnboardingStore((s) => s.updateData);
  const goTo = useOnboardingStore((s) => s.goTo);
  const setVoiceActive = useOnboardingStore((s) => s.setVoiceActive);

  const [index, setIndex] = useState(0);
  const [answer, setAnswer] = useState("");
  const [speaking, setSpeaking] = useState(false);

  const current = QUESTIONS[index];
  const isLast = index === QUESTIONS.length - 1;

  // When the question changes: prefill from the store + have the assistant speak it.
  useEffect(() => {
    const state = useOnboardingStore.getState();
    // Use the showcase voiceId as-is (the server picks the provider from the id), so
    // an ElevenLabs showcase voice actually speaks in that voice.
    const voiceId = state.voiceId;
    setAnswer(valueFor(QUESTIONS[index].key, state.data));
    speak(QUESTIONS[index].question, {
      voiceId,
      onStart: () => setSpeaking(true),
      onEnd: () => setSpeaking(false),
    });
    // Warm the next question so it starts the moment the user advances.
    const next = QUESTIONS[index + 1];
    if (next) prefetchSpeech(next.question, voiceId);
    return () => stopSpeaking();
  }, [index]);

  // Prefetch every question's audio up front so each one plays instantly.
  useEffect(() => {
    const v = useOnboardingStore.getState().voiceId;
    for (const q of QUESTIONS) prefetchSpeech(q.question, v);
  }, []);

  // Stop any speech if the component unmounts.
  useEffect(() => () => stopSpeaking(), []);

  function saveCurrent() {
    const v = answer.trim();
    if (current.key === "services") {
      const arr = v
        .split(/[,\n]|(?:\s+\band\b\s+)/i)
        .map((s) => s.trim())
        .filter(Boolean);
      updateData({ services: arr });
    } else {
      updateData({ [current.key]: v } as Partial<OnboardingData>);
    }
  }

  function handleNext() {
    saveCurrent();
    stopSpeaking();
    if (isLast) {
      setVoiceActive(false);
      goTo(5); // jump to the Preview step
    } else {
      setIndex((i) => i + 1);
    }
  }

  function handleBack() {
    stopSpeaking();
    if (index === 0) {
      setVoiceActive(false); // leave voice setup → manual form
    } else {
      saveCurrent();
      setIndex((i) => i - 1);
    }
  }

  function repeat() {
    speak(current.question, {
      voiceId: useOnboardingStore.getState().voiceId,
      onStart: () => setSpeaking(true),
      onEnd: () => setSpeaking(false),
    });
  }

  function switchToManual() {
    stopSpeaking();
    setVoiceActive(false);
  }

  return (
    <OnboardingShell step={2} autoSpeak={false} speaking={speaking} onBack={handleBack} message={current.question}>
      <div className="rounded-[var(--radius-card)] border border-border bg-card p-6 shadow-[var(--shadow-soft)]">
        {/* progress */}
        <div className="mb-4 flex items-center justify-between">
          <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Question {index + 1} of {QUESTIONS.length}
          </span>
          <div className="flex items-center gap-1.5">
            {QUESTIONS.map((q, i) => (
              <span
                key={q.key}
                className={cn(
                  "h-1.5 rounded-full transition-all",
                  i === index ? "w-5 bg-primary" : i < index ? "w-1.5 bg-primary/50" : "w-1.5 bg-border",
                )}
              />
            ))}
          </div>
        </div>

        <label className="block text-sm font-medium">{current.label}</label>
        {current.multiline ? (
          <Textarea
            autoFocus
            value={answer}
            onChange={(e) => setAnswer(e.target.value)}
            placeholder={current.placeholder}
            className="mt-2"
          />
        ) : (
          <Input
            autoFocus
            value={answer}
            onChange={(e) => setAnswer(e.target.value)}
            placeholder={current.placeholder}
            className="mt-2"
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                handleNext();
              }
            }}
          />
        )}

        {/* helper actions */}
        <div className="mt-3 flex items-center gap-4 text-xs">
          {ttsSupported && (
            <button
              type="button"
              onClick={repeat}
              className="inline-flex items-center gap-1 font-medium text-primary hover:underline"
            >
              <Volume2 className="size-3.5" /> {speaking ? "Speaking…" : "Hear again"}
            </button>
          )}
          <button
            type="button"
            onClick={switchToManual}
            className="inline-flex items-center gap-1 font-medium text-muted-foreground hover:text-foreground"
          >
            <Keyboard className="size-3.5" /> Fill in manually instead
          </button>
        </div>

        <OnboardingNav>
          <Button className="w-full gap-2" onClick={handleNext}>
            {isLast ? (
              <>
                <Check className="size-4" /> Finish setup
              </>
            ) : (
              <>
                Next <ArrowRight className="size-4" />
              </>
            )}
          </Button>
        </OnboardingNav>
      </div>
    </OnboardingShell>
  );
}
