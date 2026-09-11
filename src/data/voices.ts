import type { VoiceOption } from "@/types";

/**
 * Voice catalog (Deepgram Aura-2). `id` is the Deepgram voice short name — sent to
 * Vapi's "deepgram" provider (model "aura-2") and to /api/tts. Mirrors the server
 * catalog (server/src/services/voices.ts CATALOG); keep both in sync. The live
 * AI-Brain picker uses the server catalog (with plan entitlement) — this local copy
 * backs onboarding labels + the prompt compiler. Premium gating is plan-driven
 * server-side, so `premium` here is informational only.
 */
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

/** The voice every account starts on — Deepgram's Australian female (aura-2-theia-en).
 *  Mirrors the server's `DEFAULT_VOICE_ID` (services/voices.ts). This is the single
 *  default used by onboarding, the default agent config, and the empty-voice
 *  fallback — keep all three in sync. */
export const DEFAULT_VOICE_ID = "theia"; // Emma — Deepgram aura-2-theia-en (Australian female)

/** Resolve a stored voiceId to a valid Deepgram voice short name: pass current
 *  catalog ids through, else fall back to the default (guards empty/unknown ids).
 *  The result is sent to Vapi's "deepgram" provider. Mirrors the server's resolver. */
export function deepgramVoiceFor(voiceId: string | undefined | null): string {
  if (voiceId && DEEPGRAM_VOICE_IDS.has(voiceId)) return voiceId;
  return DEFAULT_VOICE_ID;
}

/* ------------------------------ ElevenLabs voices ------------------------- *
 *  In ElevenLabs mode the picker is driven by the live ElevenLabs library (from
 *  the server /api/voices), so a selected voiceId is a real ElevenLabs voice_id.
 *  This resolver (mirrors server services/voices.ts) handles web test calls:
 *  a real ElevenLabs id passes through; a legacy Deepgram catalog name is mapped
 *  to a close premade; empty/unknown → the default premade. */
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

/** Which provider a stored voiceId belongs to (mirrors the server). A Deepgram
 *  catalog name → "deepgram"; any other non-empty id is an ElevenLabs voice_id →
 *  "elevenlabs"; empty → the passed fallback (the global default). Keeps an existing
 *  ElevenLabs agent on ElevenLabs even if the global toggle later flips. */
export function providerForVoiceId(
  voiceId: string | undefined | null,
  fallback: "deepgram" | "elevenlabs" = "deepgram",
): "deepgram" | "elevenlabs" {
  const v = (voiceId ?? "").trim();
  if (!v) return fallback;
  return DEEPGRAM_VOICE_IDS.has(v) ? "deepgram" : "elevenlabs";
}

/* ------------------------- Eleven v3 model routing ------------------------- *
 *  Mirrors the server (server/src/services/voices.ts). Turbo v2.5 doesn't carry
 *  every language convincingly, so a call switches TTS model only when the agent
 *  is on one of the pinned voices below AND has that voice's language enabled.
 *  Everything else stays on eleven_turbo_v2_5.
 * -------------------------------------------------------------------------- */

export const ELEVEN_DEFAULT_MODEL = "eleven_turbo_v2_5";
export const ELEVEN_V3_MODEL = "eleven_v3";

/** Pinned ElevenLabs voices that need Eleven v3, keyed by the agent-language name
 *  (as stored in identity.languages) that triggers it. Mirrors the server's
 *  CURATED_VOICE_SPECS + V3_VOICE_LANGUAGES (server/src/services/voices.ts) — keep
 *  both in sync, the same way this file already mirrors the Deepgram catalog. */
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

/** The headline voices shown on the landing page "Choose your voice". Ids are
 *  ElevenLabs premade voice_ids (resolve the provider with providerForVoiceId —
 *  NOT deepgramVoiceFor, which would collapse them all to the default Deepgram
 *  voice) so the exact voice a visitor picks flows unchanged through
 *  onboarding → agent config → test calls → the live agent. */
export const LANDING_VOICES: { id: string; name: string; flag: string; region: string }[] = [
  // `name` is just the friendly display label shown on the tile — the id is the
  // real ElevenLabs premade voice (Matilda / Laura / Charlie / George).
  { id: "XrExE9yKIg1WjnnlVkGX", name: "Emma", flag: "🇺🇸", region: "American" },
  { id: "FGY2WhTYpPnrIDTdsKH5", name: "Olivia", flag: "🇺🇸", region: "American" },
  { id: "IKne3meq5aSn9XLyUdCD", name: "Jack", flag: "🇦🇺", region: "Australian" },
  { id: "JBFqnCBsd6RMkjVDRZzb", name: "James", flag: "🇬🇧", region: "British" },
];

/** Friendly display name for a stored voiceId, used where the live catalog isn't
 *  loaded (onboarding screens). Resolves the landing/showcase ElevenLabs voices and
 *  Deepgram catalog names; falls back to the default voice's name (Sarah). */
export function voiceNameFor(voiceId: string): string {
  const landing = LANDING_VOICES.find((v) => v.id === voiceId);
  if (landing) return landing.name;
  return getVoice(voiceId)?.name ?? "Sarah";
}

/* ------------------------------- Avatars ---------------------------------- *
 *  Onboarding shows a photo avatar for the AI receptionist (the way competitors
 *  give their persona a face). We don't have a portrait per voice, so we pick a
 *  gendered stock headshot from the selected voice. Swap these URLs for branded
 *  photos anytime — EmmaAvatar falls back to its gradient icon if a URL fails. */

/** Voices that read as masculine — everything else defaults to feminine (the
 *  brand default Theia and the bulk of the Aura-2 catalog are female). Covers the
 *  Deepgram catalog ids plus the landing/showcase ElevenLabs male voices. */
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

/** Photo URL for the onboarding receptionist avatar, chosen by the voice's
 *  gender. Prefers the admin-configured branding image (avatarFemale/avatarMale
 *  from the branding store), falling back to the built-in stock headshot. */
export function avatarForVoice(
  voiceId: string,
  overrides?: { avatarFemale?: string; avatarMale?: string },
): string {
  const gender = voiceGenderFor(voiceId);
  const override = gender === "male" ? overrides?.avatarMale : overrides?.avatarFemale;
  return override?.trim() || DEFAULT_AVATAR_BY_GENDER[gender];
}

// TIMEZONES (a 7-entry Australia-only list of display labels) was removed —
// the agent's timezone is an IANA zone now, picked from every zone the runtime
// knows. See lib/timezone.ts.
