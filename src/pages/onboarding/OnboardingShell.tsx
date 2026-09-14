import { useEffect, useState, type ReactNode } from "react";
import { Link, useNavigate } from "react-router-dom";
import { ArrowLeft, ArrowRight, Check, LogOut, PhoneCall, Volume2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { EmmaAvatar } from "@/components/brand/EmmaAvatar";
import { BrandLogo } from "@/components/branding/BrandLogo";
import { Wordmark } from "@/components/branding/Wordmark";
import { ONBOARDING_TOTAL_STEPS, useOnboardingStore } from "@/stores/useOnboardingStore";
import { useAuthStore } from "@/stores/useAuthStore";
import { avatarForVoice, voiceNameFor } from "@/data/voices";
import { useBrandingStore } from "@/stores/useBrandingStore";
import { speak, stopSpeaking, ttsSupported } from "@/lib/speech";

/* The left stepper has 4 groups spanning the 6 steps. */
const GROUPS = ["Agent Setup", "Account", "Services", "Finish"] as const;

function groupIndexForStep(step: number): number {
  if (step <= 2) return 0; // Agent Setup (analysis + business)
  if (step <= 4) return 1; // Account (details + verify)
  if (step === 5) return 2; // Services
  return 3; // Finish (overview)
}

export function OnboardingShell({
  step,
  message,
  speech,
  autoSpeak = true,
  speaking: speakingProp,
  onSpeechEnd,
  onBack,
  wide = false,
  aside,
  children,
}: {
  step: number;
  message: ReactNode;
  /** Text spoken aloud; falls back to `message` when it's a plain string. */
  speech?: string;
  /** When true (default) the shell reads `speech` with the selected voice. */
  autoSpeak?: boolean;
  /** Manual speaking indicator, used when `autoSpeak` is false. */
  speaking?: boolean;
  /** Fires once the auto-spoken message finishes (or can't play). */
  onSpeechEnd?: () => void;
  /** Shows a Back control in the top bar next to the step counter. */
  onBack?: () => void;
  /** Widens the content column for multi-column step layouts (e.g. the finish overview). */
  wide?: boolean;
  /** Optional right-hand panel (e.g. a live agent preview) shown beside the step content. */
  aside?: ReactNode;
  children: ReactNode;
}) {
  const activeGroup = groupIndexForStep(step);
  const voiceId = useOnboardingStore((s) => s.voiceId);
  const agentName = voiceNameFor(voiceId);
  const brandingAssets = useBrandingStore((s) => s.assets);
  const furthestStep = useOnboardingStore((s) => s.furthestStep);
  const resumeForward = useOnboardingStore((s) => s.resumeForward);
  // When the user has stepped back, offer a jump forward to the pending step.
  const canResume = step > 1 && step < furthestStep;

  // Post-OTP the user has a live session — give them a sign-out so they're not stuck in the flow with no exit.
  const navigate = useNavigate();
  const authed = useAuthStore((s) => s.status === "authed");
  const logout = useAuthStore((s) => s.logout);
  function handleSignOut() {
    stopSpeaking();
    logout();
    navigate("/login", { replace: true });
  }

  const spokenText = speech ?? (typeof message === "string" ? message : undefined);
  const [autoSpeaking, setAutoSpeaking] = useState(false);

  // Read the step's message aloud with the chosen voice whenever it changes.
  useEffect(() => {
    if (!autoSpeak || !spokenText) return;
    // Use the voiceId as-is (the server picks the provider from the id), so an
    // ElevenLabs showcase voice keeps speaking through onboarding.
    speak(spokenText, {
      voiceId,
      onStart: () => setAutoSpeaking(true),
      onEnd: () => {
        setAutoSpeaking(false);
        onSpeechEnd?.();
      },
    });
    return () => stopSpeaking();
    // onSpeechEnd is intentionally excluded: it reads a stable ref on the caller.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoSpeak, spokenText, voiceId]);

  const speaking = autoSpeak ? autoSpeaking : speakingProp ?? true;

  function replay() {
    if (!spokenText) return;
    speak(spokenText, {
      voiceId,
      onStart: () => setAutoSpeaking(true),
      onEnd: () => setAutoSpeaking(false),
    });
  }

  const progressPct = ((activeGroup + 1) / GROUPS.length) * 100;

  return (
    <div className="min-h-screen bg-background lg:grid lg:grid-cols-[minmax(0,400px)_1fr]">
      {/* ---------------- Mobile floating strip (app-setup header) ---------------- */}
      <header className="sticky top-0 z-30 border-b border-border bg-card/95 backdrop-blur-md lg:hidden">
        {/* nav row: back / logo + step count */}
        <div className="flex items-center gap-2 px-4 pt-3">
          {onBack ? (
            <button
              type="button"
              onClick={onBack}
              className="inline-flex items-center gap-1 rounded-lg border border-border bg-background px-2.5 py-1 text-xs font-medium text-foreground transition-colors hover:border-primary/40 hover:text-primary"
              aria-label="Back"
            >
              <ArrowLeft className="size-3.5" /> Back
            </button>
          ) : (
            <Link to="/" className="flex items-center gap-1.5 font-semibold">
              <BrandLogo imgClassName="h-6 w-auto max-w-[120px] object-contain">
                <span className="flex size-6 items-center justify-center rounded-lg bg-primary text-primary-foreground">
                  <PhoneCall className="size-3.5" />
                </span>
                <span className="text-sm">
                  <Wordmark />
                </span>
              </BrandLogo>
            </Link>
          )}
          <span className="ml-auto text-xs font-medium text-muted-foreground">
            Step {step} of {ONBOARDING_TOTAL_STEPS}
          </span>
          {canResume && (
            <button
              type="button"
              onClick={resumeForward}
              className="inline-flex items-center gap-1 rounded-lg border border-primary/40 bg-primary-tint px-2.5 py-1 text-xs font-medium text-primary"
              aria-label="Continue to current step"
            >
              Next <ArrowRight className="size-3.5" />
            </button>
          )}
          {authed && (
            <button
              type="button"
              onClick={handleSignOut}
              className="rounded-lg border border-border bg-background p-1.5 text-muted-foreground transition-colors hover:border-danger/40 hover:text-danger"
              aria-label="Sign out"
            >
              <LogOut className="size-3.5" />
            </button>
          )}
        </div>

        {/* profile + spoken message */}
        <div className="flex items-center gap-3 px-4 py-2.5">
          <div className="shrink-0">
            <EmmaAvatar
              size={46}
              speaking={speaking}
              name={agentName}
              img={avatarForVoice(voiceId, brandingAssets)}
            />
          </div>
          <div className="min-w-0 flex-1">
            <p className="flex items-center gap-1.5 text-[13px] font-semibold leading-tight text-foreground">
              {agentName}
              <span className="truncate text-[11px] font-normal text-muted-foreground">
                · Your AI receptionist
              </span>
            </p>
            <div className="mt-0.5 line-clamp-2 text-xs leading-snug text-foreground/80">{message}</div>
          </div>
          {ttsSupported && spokenText && (
            <button
              type="button"
              onClick={replay}
              disabled={speaking}
              className="grid size-9 shrink-0 place-items-center rounded-full border border-border bg-background text-primary transition-opacity hover:opacity-80 disabled:opacity-100"
              aria-label={speaking ? "Speaking" : "Listen again"}
            >
              <Volume2 className={cn("size-4", speaking && "animate-pulse")} />
            </button>
          )}
        </div>

        {/* group progress */}
        <div className="flex items-center gap-2.5 px-4 pb-2.5">
          <div className="h-1 flex-1 overflow-hidden rounded-full bg-muted">
            <div
              className="h-full rounded-full bg-primary transition-all"
              style={{ width: `${progressPct}%` }}
            />
          </div>
          <span className="shrink-0 text-[10px] font-medium text-muted-foreground">
            {GROUPS[activeGroup]} · {activeGroup + 1}/{GROUPS.length}
          </span>
        </div>
      </header>

      {/* ---------------- Left rail (desktop only) ---------------- */}
      <aside className="hidden flex-col border-b border-border bg-card px-6 py-6 lg:sticky lg:top-0 lg:flex lg:h-screen lg:border-b-0 lg:border-r lg:px-8 lg:py-8">
        <Link to="/" className="flex items-center gap-2 font-semibold">
          <BrandLogo imgClassName="h-12 w-auto max-w-[220px] object-contain">
            <span className="flex size-8 items-center justify-center rounded-xl bg-primary text-primary-foreground shadow-sm">
              <PhoneCall className="size-4" />
            </span>
            <span>
              <Wordmark />
            </span>
          </BrandLogo>
        </Link>

        {/* Emma + message — vertically centered on desktop */}
        <div className="flex flex-1 flex-col items-center justify-center py-5 text-center lg:py-6">
          <EmmaAvatar
            size={104}
            speaking={speaking}
            name={agentName}
            img={avatarForVoice(voiceId, brandingAssets)}
          />
          <p className="mt-4 text-base font-semibold text-foreground">{agentName}</p>
          <p className="text-xs text-muted-foreground">Your AI receptionist</p>

          <div className="mt-5 w-full max-w-sm rounded-2xl border border-border bg-background px-5 py-4 text-center">
            <div className="text-[15px] font-medium leading-relaxed text-foreground">{message}</div>
            {ttsSupported && spokenText && (
              <button
                type="button"
                onClick={replay}
                disabled={speaking}
                className="mt-2 inline-flex items-center gap-1 text-xs font-medium text-primary transition-opacity hover:opacity-80 disabled:opacity-100"
              >
                <Volume2 className={cn("size-3.5", speaking && "animate-pulse")} />{" "}
                {speaking ? "Speaking…" : "Listen again"}
              </button>
            )}
          </div>
        </div>

        {/* Stepper — desktop vertical with hairline connector, mobile progress bar */}
        <div>
          <ol className="relative hidden flex-col gap-5 pl-1 lg:flex">
            <span aria-hidden className="absolute left-[14px] top-3 bottom-3 w-px bg-border" />
            {GROUPS.map((g, i) => {
              const done = i < activeGroup;
              const active = i === activeGroup;
              return (
                <li key={g} className="relative flex items-center gap-3">
                  <span
                    className={cn(
                      "z-10 flex size-7 items-center justify-center rounded-full border text-xs font-semibold transition-all",
                      done && "border-primary bg-primary text-primary-foreground",
                      active && "border-primary bg-card text-primary shadow-[0_0_0_4px_var(--color-primary-tint)]",
                      !done && !active && "border-border bg-card text-muted-foreground",
                    )}
                  >
                    {done ? (
                      <Check className="size-4" />
                    ) : active ? (
                      <span className="size-2 rounded-full bg-primary" />
                    ) : (
                      i + 1
                    )}
                  </span>
                  <span
                    className={cn(
                      "text-sm font-medium transition-colors",
                      active ? "text-foreground" : done ? "text-foreground/80" : "text-muted-foreground",
                    )}
                  >
                    {g}
                  </span>
                </li>
              );
            })}
          </ol>

          {/* mobile: compact progress bar */}
          <div className="lg:hidden">
            <div className="mb-1.5 flex items-center justify-between text-xs font-medium text-muted-foreground">
              <span className="text-foreground">{GROUPS[activeGroup]}</span>
              <span>
                {activeGroup + 1} / {GROUPS.length}
              </span>
            </div>
            <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
              <div className="h-full rounded-full bg-primary transition-all" style={{ width: `${progressPct}%` }} />
            </div>
          </div>
        </div>
      </aside>

      {/* ---------------- Right content ---------------- */}
      <main className="flex flex-col lg:min-h-screen">
        {/* top bar: step counter + nav controls (desktop — mobile uses the strip) */}
        <div className="hidden items-center justify-end gap-2 px-6 py-5 sm:gap-3 sm:px-10 lg:flex">
          {onBack && (
            <button
              type="button"
              onClick={onBack}
              className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-card px-3 py-1.5 text-sm font-medium text-foreground transition-colors hover:border-primary/40 hover:text-primary"
              aria-label="Back"
            >
              <ArrowLeft className="size-4" /> Back
            </button>
          )}
          {canResume && (
            <button
              type="button"
              onClick={resumeForward}
              className="inline-flex items-center gap-1.5 rounded-lg border border-primary/40 bg-primary-tint px-3 py-1.5 text-sm font-medium text-primary transition-colors hover:bg-primary/15"
              aria-label="Continue to current step"
            >
              Next <ArrowRight className="size-4" />
            </button>
          )}
          <span className="ml-1 text-sm text-muted-foreground">
            Step {step} of {ONBOARDING_TOTAL_STEPS}
          </span>
          {authed && (
            <button
              type="button"
              onClick={handleSignOut}
              className="ml-2 inline-flex items-center gap-1.5 rounded-lg border border-border bg-card px-3 py-1.5 text-sm font-medium text-muted-foreground transition-colors hover:border-danger/40 hover:text-danger"
              aria-label="Sign out"
            >
              <LogOut className="size-4" /> Sign out
            </button>
          )}
        </div>

        {/* content — comfortably wide, re-animates per step. Flows from the top on
            mobile (no forced full-height centering) and vertically centers on desktop. */}
        <div className="flex flex-1 flex-col items-center justify-start px-6 pb-10 pt-2 sm:px-10 lg:justify-center lg:pb-16">
          <div key={step} className={cn("w-full animate-in", wide || aside ? "max-w-4xl" : "max-w-xl")}>
            {aside ? (
              <div className="grid items-start gap-6 md:grid-cols-2">
                <div>{children}</div>
                <div>{aside}</div>
              </div>
            ) : (
              children
            )}
          </div>
        </div>
      </main>
    </div>
  );
}

/** Standard footer action: a full-width primary button. (Back lives in the top bar.) */
export function OnboardingNav({ children }: { children: ReactNode }) {
  return <div className="mt-6">{children}</div>;
}
