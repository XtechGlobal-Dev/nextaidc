/** Languages a multilingual-plan customer may enable for their assistant, beyond
 *  the English base. Bounded by what the call pipeline actually supports (see the
 *  server list in server/src/lib/agentConfig.ts, SUPPORTED_AGENT_LANGUAGES — the
 *  server sanitizes saves against its copy). Keep the two lists identical. */
export const AGENT_LANGUAGES = [
  "Hindi",
  // Punjabi hidden for now — not offering it as a switch-to language yet.
  // Uncomment (here + SUPPORTED_AGENT_LANGUAGES on the server) to bring it back.
  // "Punjabi",
  // "Chinese" alone is ambiguous to the LLM (Mandarin vs Cantonese) — name the
  // dialect our Chinese voices actually speak so it can't answer in the other one.
  "Chinese (Mandarin)",
  "Nepali",
  "Spanish",
  "French",
  "German",
  "Italian",
  "Portuguese",
  "Dutch",
  "Russian",
  "Japanese",
] as const;

export type AgentLanguage = (typeof AGENT_LANGUAGES)[number];

/** Languages Deepgram nova-3's `language: "multi"` can transcribe alongside English.
 *  Mirrors the server (lib/agentConfig.ts) — matched to Deepgram's published set,
 *  NOT to our language catalogue. */
const DEEPGRAM_MULTI_LANGUAGES: readonly string[] = [
  "Hindi",
  "Spanish",
  "French",
  "German",
  "Italian",
  "Portuguese",
  "Dutch",
  "Russian",
  "Japanese",
];

/** Google's transcriber model — Vapi validates against a fixed Gemini list and
 *  rejects "latest". See the server copy (lib/agentConfig.ts). */
const GOOGLE_TRANSCRIBER_MODEL = "gemini-2.5-flash";

/** The speech-to-text config for a set of enabled languages. */
export type TranscriberConfig =
  | { provider: "deepgram"; model: "nova-3"; language: "en" | "multi" }
  | { provider: "google"; model: string; language: "Multilingual" };

/** Transcriber for this agent's languages — Deepgram where it has coverage, Google's
 *  multilingual model for Punjabi/Mandarin. Mirrors the server so a web test call
 *  transcribes exactly like a real inbound one. */
export function transcriberFor(languages: readonly string[]): TranscriberConfig {
  if (!languages.length) return { provider: "deepgram", model: "nova-3", language: "en" };
  const deepgramCovers = languages.every((l) => DEEPGRAM_MULTI_LANGUAGES.includes(l));
  if (deepgramCovers) return { provider: "deepgram", model: "nova-3", language: "multi" };
  // Google only — no Deepgram fallback. See the server copy (lib/agentConfig.ts).
  // Vapi requires Title-Cased "Multilingual" — see the server copy (agentConfig.ts).
  return { provider: "google", model: GOOGLE_TRANSCRIBER_MODEL, language: "Multilingual" };
}

/** Languages only offered on an ElevenLabs voice. Deepgram's Aura-2 voices are
 *  English-only and the rest of the Deepgram pipeline has no coverage for these
 *  two, so offering them alongside a Deepgram voice would promise something the
 *  agent can't deliver. Mirrored server-side (lib/agentConfig.ts). */
export const ELEVENLABS_ONLY_LANGUAGES: readonly string[] = [
  "Punjabi",
  "Chinese (Mandarin)",
  "Nepali",
];

/** The languages selectable for a given voice provider. A Deepgram voice hides
 *  the ElevenLabs-only ones; ElevenLabs (and unknown/empty) gets the full list. */
export function languagesForVoiceProvider(
  provider: "deepgram" | "elevenlabs" | undefined,
): readonly string[] {
  return provider === "deepgram"
    ? AGENT_LANGUAGES.filter((l) => !ELEVENLABS_ONLY_LANGUAGES.includes(l))
    : AGENT_LANGUAGES;
}
