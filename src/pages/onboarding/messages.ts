// Onboarding spoken lines live here so OnboardingPage can prefetch all the audio up front,
// and the steps render the same constants so the cached audio never drifts from the text.

export const ONBOARDING_SPEECH = {
  step1:
    "Analyzing your business — this'll only take a moment.",
  step2HasDetails: "Great — I found your business! Can you confirm this is correct?",
  step2NoDetails: "Tell me a bit about your business so I know how to help your callers.",
  step3: "Almost there! Let's set up your account so I can start handling your calls.",
  step4: "I've sent a 6-digit code to your email and your phone. Enter it to confirm it's really you.",
  step5: "Here are the services I found on your website. Feel free to edit or add any I missed.",
  step5NoServices:
    "Add the services your business offers, so I know exactly what I can help your callers with.",
  step6: "That's everything! Here's a quick overview before we finish setting you up.",
} as const;

/** Every spoken line, for up-front prefetching. */
export const ALL_ONBOARDING_SPEECH: string[] = Object.values(ONBOARDING_SPEECH);
