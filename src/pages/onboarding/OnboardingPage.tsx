import { useEffect } from "react";
import { Navigate } from "react-router-dom";
import { useOnboardingStore } from "@/stores/useOnboardingStore";
import { useAuthStore } from "@/stores/useAuthStore";
import { prefetchSpeech } from "@/lib/speech";
import { onboardingRedirectPath } from "@/lib/onboardingRoute";
import { ALL_ONBOARDING_SPEECH } from "./messages";
import Step1AgentSetup from "./steps/Step1AgentSetup";
import Step2Business from "./steps/Step2Business";
import Step3Account from "./steps/Step3Account";
import Step4Verify from "./steps/Step4Verify";
import Step5Services from "./steps/Step5Services";
import Step7Finish from "./steps/Step7Finish";
import VoiceSetup from "./VoiceSetup";

export default function OnboardingPage() {
  const step = useOnboardingStore((s) => s.step);
  const url = useOnboardingStore((s) => s.data.url);
  const skippedWebsite = useOnboardingStore((s) => s.skippedWebsite);
  const accountCreated = useOnboardingStore((s) => s.accountCreated);
  const voiceActive = useOnboardingStore((s) => s.voiceActive);
  const voiceId = useOnboardingStore((s) => s.voiceId);
  // A signed-in user hitting /onboarding is resuming a half-finished flow.
  const authed = useAuthStore((s) => s.status === "authed");
  const user = useAuthStore((s) => s.user);

  // Prefetch every step's spoken line up front (for the chosen voice) so each
  // step's voice plays instantly from cache instead of generating on arrival.
  useEffect(() => {
    // Pass the voiceId as-is (the server picks the provider from the id), so an
    // ElevenLabs showcase voice prefetches in that voice, not the Deepgram default.
    for (const line of ALL_ONBOARDING_SPEECH) prefetchSpeech(line, voiceId);
  }, [voiceId]);

  // No website → landing page, but never bounce an authed/resuming user: sign-out clears the onboarding
  // cache, and bouncing them ping-ponged with RedirectIfAuthed into a blank loop.
  if (!url && !skippedWebsite && !authed && !accountCreated) return <Navigate to="/" replace />;

  // /onboarding has no RequireAuth, so a card-walled user could come back here to dodge paying.
  // Reuse the single redirect decider rather than re-implementing the rule.
  if (user && onboardingRedirectPath(user) === "/subscribe") {
    return <Navigate to="/subscribe" replace />;
  }

  // Guided voice setup overrides the regular step views while active.
  if (voiceActive) return <VoiceSetup />;

  switch (step) {
    case 1:
      return <Step1AgentSetup />;
    case 2:
      return <Step2Business />;
    case 3:
      return <Step3Account />;
    case 4:
      return <Step4Verify />;
    case 5:
      return <Step5Services />;
    case 6:
      return <Step7Finish />;
    default:
      return <Step2Business />;
  }
}
