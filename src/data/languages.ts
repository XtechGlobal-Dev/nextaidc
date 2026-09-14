/** Extra languages a multilingual-plan customer can enable. Must match SUPPORTED_AGENT_LANGUAGES
 *  in server/src/lib/agentConfig.ts — the server sanitizes saves against its copy. */
export const AGENT_LANGUAGES = [
  "Hindi",
  // Punjabi hidden for now — re-enable here + SUPPORTED_AGENT_LANGUAGES on the server together.
  // "Punjabi",
  // Plain "Chinese" is ambiguous to the LLM (Mandarin vs Cantonese) — name the dialect our voices speak.
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

/** What Deepgram nova-3 `language: "multi"` can transcribe — Deepgram's published set, NOT our
 *  catalogue. Mirrors server/src/lib/agentConfig.ts. */
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

/** Transcriber for the agent's languages — Deepgram where covered, else Google multilingual.
 *  Mirrors the server so a web test call transcribes like a real inbound one. */
export function transcriberFor(languages: readonly string[]): TranscriberConfig {
  if (!languages.length) return { provider: "deepgram", model: "nova-3", language: "en" };
  const deepgramCovers = languages.every((l) => DEEPGRAM_MULTI_LANGUAGES.includes(l));
  if (deepgramCovers) return { provider: "deepgram", model: "nova-3", language: "multi" };
  // Google only — no Deepgram fallback. See the server copy (lib/agentConfig.ts).
  // Vapi requires Title-Cased "Multilingual" — see the server copy (agentConfig.ts).
  return { provider: "google", model: GOOGLE_TRANSCRIBER_MODEL, language: "Multilingual" };
}

/** ElevenLabs-only languages — Deepgram's Aura-2 voices are English-only, so offering these with a
 *  Deepgram voice would promise what the agent can't deliver. Mirrors server/src/lib/agentConfig.ts. */
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
