import { useEffect, useRef, useState } from "react";
import { OnboardingShell } from "../OnboardingShell";
import { ONBOARDING_SPEECH } from "../messages";
import { AgentCallPreview } from "@/components/onboarding/AgentCallPreview";
import { ProgressBar } from "@/components/ui/misc";
import { useOnboardingStore } from "@/stores/useOnboardingStore";
import { voiceNameFor } from "@/data/voices";

export default function Step1AgentSetup() {
  const analyzeFromUrl = useOnboardingStore((s) => s.analyzeFromUrl);
  const next = useOnboardingStore((s) => s.next);
  const voiceId = useOnboardingStore((s) => s.voiceId);
  const agentName = voiceNameFor(voiceId);
  const [pct, setPct] = useState(0);
  const doneRef = useRef(false);
  // Resolved when Emma finishes speaking the intro (or audio can't play).
  const speechDoneRef = useRef<() => void>(() => {});
  const speechDone = useRef<Promise<void> | undefined>(undefined);
  if (!speechDone.current) {
    speechDone.current = new Promise<void>((resolve) => {
      speechDoneRef.current = resolve;
    });
  }

  useEffect(() => {
    const start = Date.now();
    const TICK_MS = 150;
    const id = window.setInterval(() => {
      const elapsed = Date.now() - start;
      setPct((prev) => {
        // Quick ease to 20% in the first ~500ms so it feels responsive…
        if (elapsed < 500) return Math.min(20, (elapsed / 500) * 20);
        // …then keep nudging forward EVERY tick so it never looks stuck. The
        // speed starts gentle and decays toward a floor (never zero), so the bar
        // always inches ahead while the analysis runs — capped just short of
        // 100 until the real data actually lands.
        if (prev >= 99) return 99;
        const over = elapsed - 500;
        const speedPerSec = Math.max(0.8, 4 * Math.exp(-over / 20000));
        return Math.min(99, prev + speedPerSec * (TICK_MS / 1000));
      });
    }, TICK_MS);

    // Safety net: never wait on the voice for longer than this.
    const speechCap = window.setTimeout(() => speechDoneRef.current(), 12000);

    // Advance ONLY once the website data is actually fetched (analyzeFromUrl
    // resolves — success or handled error) AND Emma has read the intro out.
    // No artificial cap: we never jump to the next screen before the data lands.
    const minDelay = new Promise<void>((r) => window.setTimeout(r, 1800));
    Promise.all([analyzeFromUrl(), minDelay, speechDone.current]).finally(() => {
      if (doneRef.current) return;
      doneRef.current = true;
      window.clearInterval(id);
      window.clearTimeout(speechCap);
      setPct(100);
      window.setTimeout(() => next(), 300);
    });

    return () => {
      window.clearInterval(id);
      window.clearTimeout(speechCap);
    };
  }, [analyzeFromUrl, next]);

  return (
    <OnboardingShell
      step={1}
      onSpeechEnd={() => speechDoneRef.current()}
      message={ONBOARDING_SPEECH.step1}
      aside={<AgentCallPreview scenario="training" />}
    >
      <div className="rounded-[var(--radius-card)] border border-border bg-card p-6 shadow-[var(--shadow-soft)]">
        <p className="text-sm font-medium text-muted-foreground">{agentName} is analyzing your website…</p>
        <div className="mt-4">
          <ProgressBar value={Math.round(pct)} />
        </div>
        <p className="mt-3 text-sm font-medium text-foreground">{Math.round(pct)}% complete</p>
      </div>
    </OnboardingShell>
  );
}
