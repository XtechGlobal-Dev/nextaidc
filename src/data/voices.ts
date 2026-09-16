import type { VoiceOption } from "@/types";

/** Deepgram Aura-2 catalog — mirrors CATALOG in server/src/services/voices.ts, keep in sync. Backs
 *  onboarding labels + the prompt compiler; the live picker uses the server. `premium` is informational only. */
export const VOICES: VoiceOption[] = [
  // Australian (brand default leads)
  { id: "theia", name: "Theia", region: "Australian", descriptor: "Warm & Friendly", premium: false },
  { id: "hyperion", name: "Hyperion", region: "Australian", descriptor: "Friendly & Professional", premium: false },
  // British
  { id: "pandora", name: "Pandora", region: "British", descriptor: "Smooth & Calm", premium: false },
  { id: "draco", name: "Draco", region: "British", descriptor: "Warm & Trustworthy", premium: false },
  // American
  { id: "thalia", name: "Thalia", region: "American", descriptor: "Clear & Confident", premium: false },
  { id: "andromeda", name: "Andromeda", region: "American", descriptor: "Casual & Expressive", premium: false },
  { id: "helena", name: "Helena", region: "American", descriptor: "Caring & Natural", premium: false },
  { id: "apollo", name: "Apollo", region: "American", descriptor: "Confident & Casual", premium: false },
  { id: "arcas", name: "Arcas", region: "American", descriptor: "Natural & Smooth", premium: false },
  { id: "aries", name: "Aries", region: "American", descriptor: "Warm & Energetic", premium: false },
  { id: "asteria", name: "Asteria", region: "American", descriptor: "Clear & Knowledgeable", premium: false },
  { id: "athena", name: "Athena", region: "American", descriptor: "Calm & Professional", premium: false },
  { id: "atlas", name: "Atlas", region: "American", descriptor: "Enthusiastic & Friendly", premium: false },
  { id: "aurora", name: "Aurora", region: "American", descriptor: "Cheerful & Expressive", premium: false },
  { id: "callista", name: "Callista", region: "American", descriptor: "Clear & Professional", premium: false },
  { id: "cora", name: "Cora", region: "American", descriptor: "Smooth & Melodic", premium: false },
  { id: "cordelia", name: "Cordelia", region: "American", descriptor: "Warm & Polite", premium: false },
  { id: "delia", name: "Delia", region: "American", descriptor: "Casual & Cheerful", premium: false },
  { id: "electra", name: "Electra", region: "American", descriptor: "Professional & Engaging", premium: false },
  { id: "harmonia", name: "Harmonia", region: "American", descriptor: "Empathetic & Calm", premium: false },
  { id: "hera", name: "Hera", region: "American", descriptor: "Smooth & Warm", premium: false },
  { id: "hermes", name: "Hermes", region: "American", descriptor: "Expressive & Engaging", premium: false },
  { id: "iris", name: "Iris", region: "American", descriptor: "Cheerful & Positive", premium: false },
  { id: "janus", name: "Janus", region: "American", descriptor: "Southern & Trustworthy", premium: false },
  { id: "juno", name: "Juno", region: "American", descriptor: "Natural & Engaging", premium: false },
  { id: "jupiter", name: "Jupiter", region: "American", descriptor: "Expressive Baritone", premium: false },
  { id: "luna", name: "Luna", region: "American", descriptor: "Friendly & Natural", premium: false },
  { id: "mars", name: "Mars", region: "American", descriptor: "Patient & Trustworthy", premium: false },
  { id: "minerva", name: "Minerva", region: "American", descriptor: "Positive & Natural", premium: false },
  { id: "neptune", name: "Neptune", region: "American", descriptor: "Professional & Polite", premium: false },
  { id: "odysseus", name: "Odysseus", region: "American", descriptor: "Calm & Professional", premium: false },
  { id: "ophelia", name: "Ophelia", region: "American", descriptor: "Enthusiastic & Cheerful", premium: false },
  { id: "orion", name: "Orion", region: "American", descriptor: "Approachable & Calm", premium: false },
  { id: "orpheus", name: "Orpheus", region: "American", descriptor: "Smooth & Confident", premium: false },
  { id: "phoebe", name: "Phoebe", region: "American", descriptor: "Warm & Friendly", premium: false },
  { id: "pluto", name: "Pluto", region: "American", descriptor: "Calm & Empathetic", premium: false },
  { id: "saturn", name: "Saturn", region: "American", descriptor: "Calm & Smooth", premium: false },
  { id: "selene", name: "Selene", region: "American", descriptor: "Expressive & Energetic", premium: false },
  { id: "vesta", name: "Vesta", region: "American", descriptor: "Natural & Patient", premium: false },
  { id: "zeus", name: "Zeus", region: "American", descriptor: "Deep & Trustworthy", premium: false },
  // Filipino
  { id: "amalthea", name: "Amalthea", region: "Filipino", descriptor: "Engaging & Cheerful", premium: false },
];

export const VOICES_BY_REGION = VOICES.reduce<Record<string, VoiceOption[]>>(
  (acc, v) => {
    (acc[v.region] ??= []).push(v);
    return acc;
  },
  {},
);

export function getVoice(id: string): VoiceOption | undefined {
  return VOICES.find((v) => v.id === id);
}

/** Valid Deepgram voice ids (the catalog). */
const DEEPGRAM_VOICE_IDS = new Set(VOICES.map((v) => v.id));

/** Default Deepgram voice. Mirrors DEFAULT_VOICE_ID in server/src/services/voices.ts; onboarding,
 *  the default agent config and the empty-voice fallback all use it — keep in sync. */
export const DEFAULT_VOICE_ID = "theia"; // Emma — Deepgram aura-2-theia-en (Australian female)

/** Stored voiceId → valid Deepgram short name, default for empty/unknown. Mirrors the server's resolver. */
export function deepgramVoiceFor(voiceId: string | undefined | null): string {
  if (voiceId && DEEPGRAM_VOICE_IDS.has(voiceId)) return voiceId;
  return DEFAULT_VOICE_ID;
}

// ElevenLabs resolver for web test calls (mirrors server/src/services/voices.ts): a real voice_id
// passes through, a legacy Deepgram name maps to a close premade, empty → the default premade.
const LEGACY_DEEPGRAM_TO_ELEVEN: Record<string, string> = {
  theia: "EXAVITQu4vr4xnSDxMaL", // Sarah
  hyperion: "JBFqnCBsd6RMkjVDRZzb", // George
  pandora: "FGY2WhTYpPnrIDTdsKH5", // Laura
  draco: "IKne3meq5aSn9XLyUdCD", // Charlie
  thalia: "EXAVITQu4vr4xnSDxMaL", // Sarah
  apollo: "CwhRBWXzGAHq8TQ4Fs17", // Roger
};

/** ElevenLabs voice_id used when nothing else resolves (a premade id). */
export const DEFAULT_ELEVENLABS_VOICE = "EXAVITQu4vr4xnSDxMaL"; // Sarah

/** Resolve a stored voiceId to an ElevenLabs voice_id for the "11labs" provider. */
export function elevenLabsVoiceFor(voiceId: string | undefined | null): string {
  const v = (voiceId ?? "").trim();
  if (!v) return DEFAULT_ELEVENLABS_VOICE;
  if (DEEPGRAM_VOICE_IDS.has(v)) return LEGACY_DEEPGRAM_TO_ELEVEN[v] ?? DEFAULT_ELEVENLABS_VOICE;
  return v;
}

/** Provider for a stored voiceId (mirrors the server): catalog name → deepgram, other id → elevenlabs,
 *  empty → fallback. Keeps an existing ElevenLabs agent there even if the global toggle flips. */
export function providerForVoiceId(
  voiceId: string | undefined | null,
  fallback: "deepgram" | "elevenlabs" = "deepgram",
): "deepgram" | "elevenlabs" {
  const v = (voiceId ?? "").trim();
  if (!v) return fallback;
  return DEEPGRAM_VOICE_IDS.has(v) ? "deepgram" : "elevenlabs";
}

// Eleven v3 routing (mirrors server/src/services/voices.ts): switch model only when the agent is on
// a pinned voice AND has that voice's language enabled; everything else stays on turbo v2.5.

export const ELEVEN_DEFAULT_MODEL = "eleven_turbo_v2_5";
export const ELEVEN_V3_MODEL = "eleven_v3";

/** Voices needing Eleven v3, keyed by the identity.languages name that triggers it. Mirrors
 *  CURATED_VOICE_SPECS + V3_VOICE_LANGUAGES in server/src/services/voices.ts — keep in sync. */
const V3_VOICE_IDS_BY_LANGUAGE: Record<string, readonly string[]> = {
  Punjabi: ["fBXc7vfuym7wUXyB57Eo", "RxnH5jCRKb1ez2lcmQC1"],
  Nepali: ["qEvUQh8PxrzNFap49hNm"],
};

/** Is this one of the pinned voices that needs Eleven v3? */
export function needsElevenV3Voice(voiceId: string | undefined | null): boolean {
  const id = (voiceId ?? "").trim();
  return Object.values(V3_VOICE_IDS_BY_LANGUAGE).some((ids) => ids.includes(id));
}

/** ElevenLabs TTS model for a voice + the agent's enabled languages. */
export function elevenLabsModelFor(
  voiceId: string | undefined | null,
  languages: readonly string[] = [],
): string {
  const id = (voiceId ?? "").trim();
  const needsV3 = Object.entries(V3_VOICE_IDS_BY_LANGUAGE).some(
    ([language, ids]) => ids.includes(id) && languages.includes(language),
  );
  return needsV3 ? ELEVEN_V3_MODEL : ELEVEN_DEFAULT_MODEL;
}

/** Landing-page "Choose your voice" tiles. ElevenLabs premade ids — resolve with providerForVoiceId,
 *  NOT deepgramVoiceFor (which collapses them all to the Deepgram default). */
export const LANDING_VOICES: { id: string; name: string; flag: string; region: string }[] = [
  // `name` is the tile label; the ids are the real premades (Matilda / Laura / Charlie / George).
  { id: "XrExE9yKIg1WjnnlVkGX", name: "Emma", flag: "🇺🇸", region: "American" },
  { id: "FGY2WhTYpPnrIDTdsKH5", name: "Olivia", flag: "🇺🇸", region: "American" },
  { id: "IKne3meq5aSn9XLyUdCD", name: "Jack", flag: "🇦🇺", region: "Australian" },
  { id: "JBFqnCBsd6RMkjVDRZzb", name: "James", flag: "🇬🇧", region: "British" },
];

/** Display name for a voiceId where the live catalog isn't loaded (onboarding); falls back to "Sarah". */
export function voiceNameFor(voiceId: string): string {
  const landing = LANDING_VOICES.find((v) => v.id === voiceId);
  if (landing) return landing.name;
  return getVoice(voiceId)?.name ?? "Sarah";
}

// Onboarding avatar: no portrait per voice, so pick a gendered stock headshot. EmmaAvatar falls
// back to its gradient icon if a URL fails.

/** Voices that read as masculine — everything else defaults to feminine (most of the catalog is). */
const MALE_VOICE_IDS = new Set<string>([
  // Deepgram Aura-2 masculine voices
  "hyperion", "draco", "apollo", "arcas", "aries", "atlas", "hermes", "jupiter",
  "mars", "neptune", "odysseus", "orion", "orpheus", "pluto", "saturn", "zeus",
  // Landing/showcase ElevenLabs male voices (Jack, James)
  "IKne3meq5aSn9XLyUdCD", "JBFqnCBsd6RMkjVDRZzb",
]);

/** Rough gender for a voice, used only to choose the onboarding avatar photo. */
export function voiceGenderFor(voiceId: string): "male" | "female" {
  return MALE_VOICE_IDS.has(voiceId) ? "male" : "female";
}

/** Built-in stock headshots used when the admin hasn't uploaded a branded
 *  avatar for that gender. Square, face-cropped placeholders. */
export const DEFAULT_AVATAR_BY_GENDER: Record<"male" | "female", string> = {
  female:
    "https://images.unsplash.com/photo-1580489944761-15a19d654956?auto=format&fit=facearea&facepad=3&w=256&h=256&q=80",
  male:
    "https://images.unsplash.com/photo-1507003211169-0a1dd7228f2d?auto=format&fit=facearea&facepad=3&w=256&h=256&q=80",
};

/** Onboarding avatar URL by voice gender — branding override first, then the stock headshot. */
export function avatarForVoice(
  voiceId: string,
  overrides?: { avatarFemale?: string; avatarMale?: string },
): string {
  const gender = voiceGenderFor(voiceId);
  const override = gender === "male" ? overrides?.avatarMale : overrides?.avatarFemale;
  return override?.trim() || DEFAULT_AVATAR_BY_GENDER[gender];
}

// TIMEZONES list was removed — the agent's timezone is an IANA zone now, see lib/timezone.ts.
