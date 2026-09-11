import { prisma } from "../prisma.js";
import { brandIdForOwner } from "./customerDirectory.js";
import { tenantFor } from "./tenantDb.js";
import { getEffective, type VoiceProvider } from "./settings.js";
import { traceFetch } from "./apiTrace.js";
import { isAdminRole } from "../lib/roles.js";

/* ------------------------------------------------------------------ *
 *  Voice catalog + plan entitlement.
 *
 *  The AI-Brain voice picker is driven by a static catalog of Deepgram
 *  Aura-2 voices (Deepgram has no public "list voices" API to fetch). Each
 *  voice id is a Deepgram short name (e.g. "theia"), stored verbatim in
 *  agent_config and sent both to Vapi's "deepgram" provider (model "aura-2")
 *  and to /api/tts for the spoken preview. Each plan unlocks a subset
 *  (`allowedVoices`); callers can preview any voice but only *select* an
 *  entitled one. Voices span Australian (brand default), British and American.
 * ------------------------------------------------------------------ */

export interface CatalogVoice {
  id: string; // Deepgram voice short name — stored in agent_config + sent to Vapi/TTS
  name: string;
  descriptor: string; // short tone, e.g. "Warm & Friendly"
  region: string; // accent bucket, e.g. "Australian"
  previewUrl: string | null; // null — Deepgram has no per-voice CDN; preview synthesised via /api/tts
  gender?: "male" | "female" | null; // from ElevenLabs labels; drives gender-matched default names
  /** ISO 639-1 code of the language this voice was curated for (see
   *  CURATED_VOICE_SPECS) — only set on curated voices. Absent on
   *  premade/Deepgram voices, which aren't tied to one language. */
  language?: string;
}

/** The voice every account can always pick, so an agent is never left voiceless
 *  even on a plan the admin hasn't assigned any voices to. Australian female. */
export const DEFAULT_VOICE_ID = "theia"; // Emma — Deepgram aura-2-theia-en (Australian female)

/** The Deepgram Aura-2 voices we offer, across accents. Australian leads (the
 *  brand's accent + free default); British/American give the picker real choice
 *  and let admins gate premium voices per plan. Keep this in sync with the client
 *  (src/data/voices.ts) — both sides resolve/validate voiceIds against it. */
const CATALOG: CatalogVoice[] = [
  // Australian (brand default leads)
  { id: "theia", name: "Theia", descriptor: "Warm & Friendly", region: "Australian", previewUrl: null, gender: "female" },
  { id: "hyperion", name: "Hyperion", descriptor: "Friendly & Professional", region: "Australian", previewUrl: null, gender: "male" },
  // British
  { id: "pandora", name: "Pandora", descriptor: "Smooth & Calm", region: "British", previewUrl: null, gender: "female" },
  { id: "draco", name: "Draco", descriptor: "Warm & Trustworthy", region: "British", previewUrl: null, gender: "male" },
  // American
  { id: "thalia", name: "Thalia", descriptor: "Clear & Confident", region: "American", previewUrl: null, gender: "female" },
  { id: "andromeda", name: "Andromeda", descriptor: "Casual & Expressive", region: "American", previewUrl: null, gender: "female" },
  { id: "helena", name: "Helena", descriptor: "Caring & Natural", region: "American", previewUrl: null, gender: "female" },
  { id: "apollo", name: "Apollo", descriptor: "Confident & Casual", region: "American", previewUrl: null, gender: "male" },
  { id: "arcas", name: "Arcas", descriptor: "Natural & Smooth", region: "American", previewUrl: null, gender: "male" },
  { id: "aries", name: "Aries", descriptor: "Warm & Energetic", region: "American", previewUrl: null, gender: "male" },
  { id: "asteria", name: "Asteria", descriptor: "Clear & Knowledgeable", region: "American", previewUrl: null, gender: "female" },
  { id: "athena", name: "Athena", descriptor: "Calm & Professional", region: "American", previewUrl: null, gender: "female" },
  { id: "atlas", name: "Atlas", descriptor: "Enthusiastic & Friendly", region: "American", previewUrl: null, gender: "male" },
  { id: "aurora", name: "Aurora", descriptor: "Cheerful & Expressive", region: "American", previewUrl: null, gender: "female" },
  { id: "callista", name: "Callista", descriptor: "Clear & Professional", region: "American", previewUrl: null, gender: "female" },
  { id: "cora", name: "Cora", descriptor: "Smooth & Melodic", region: "American", previewUrl: null, gender: "female" },
  { id: "cordelia", name: "Cordelia", descriptor: "Warm & Polite", region: "American", previewUrl: null, gender: "female" },
  { id: "delia", name: "Delia", descriptor: "Casual & Cheerful", region: "American", previewUrl: null, gender: "female" },
  { id: "electra", name: "Electra", descriptor: "Professional & Engaging", region: "American", previewUrl: null, gender: "female" },
  { id: "harmonia", name: "Harmonia", descriptor: "Empathetic & Calm", region: "American", previewUrl: null, gender: "female" },
  { id: "hera", name: "Hera", descriptor: "Smooth & Warm", region: "American", previewUrl: null, gender: "female" },
  { id: "hermes", name: "Hermes", descriptor: "Expressive & Engaging", region: "American", previewUrl: null, gender: "male" },
  { id: "iris", name: "Iris", descriptor: "Cheerful & Positive", region: "American", previewUrl: null, gender: "female" },
  { id: "janus", name: "Janus", descriptor: "Southern & Trustworthy", region: "American", previewUrl: null, gender: "female" },
  { id: "juno", name: "Juno", descriptor: "Natural & Engaging", region: "American", previewUrl: null, gender: "female" },
  { id: "jupiter", name: "Jupiter", descriptor: "Expressive Baritone", region: "American", previewUrl: null, gender: "male" },
  { id: "luna", name: "Luna", descriptor: "Friendly & Natural", region: "American", previewUrl: null, gender: "female" },
  { id: "mars", name: "Mars", descriptor: "Patient & Trustworthy", region: "American", previewUrl: null, gender: "male" },
  { id: "minerva", name: "Minerva", descriptor: "Positive & Natural", region: "American", previewUrl: null, gender: "female" },
  { id: "neptune", name: "Neptune", descriptor: "Professional & Polite", region: "American", previewUrl: null, gender: "male" },
  { id: "odysseus", name: "Odysseus", descriptor: "Calm & Professional", region: "American", previewUrl: null, gender: "male" },
  { id: "ophelia", name: "Ophelia", descriptor: "Enthusiastic & Cheerful", region: "American", previewUrl: null, gender: "female" },
  { id: "orion", name: "Orion", descriptor: "Approachable & Calm", region: "American", previewUrl: null, gender: "male" },
  { id: "orpheus", name: "Orpheus", descriptor: "Smooth & Confident", region: "American", previewUrl: null, gender: "male" },
  { id: "phoebe", name: "Phoebe", descriptor: "Warm & Friendly", region: "American", previewUrl: null, gender: "female" },
  { id: "pluto", name: "Pluto", descriptor: "Calm & Empathetic", region: "American", previewUrl: null, gender: "male" },
  { id: "saturn", name: "Saturn", descriptor: "Calm & Smooth", region: "American", previewUrl: null, gender: "male" },
  { id: "selene", name: "Selene", descriptor: "Expressive & Energetic", region: "American", previewUrl: null, gender: "female" },
  { id: "vesta", name: "Vesta", descriptor: "Natural & Patient", region: "American", previewUrl: null, gender: "female" },
  { id: "zeus", name: "Zeus", descriptor: "Deep & Trustworthy", region: "American", previewUrl: null, gender: "male" },
  // Filipino
  { id: "amalthea", name: "Amalthea", descriptor: "Engaging & Cheerful", region: "Filipino", previewUrl: null, gender: "female" },
];

/** Valid Deepgram voice ids (the catalog) — used to validate/resolve a stored voiceId. */
export const CATALOG_VOICE_IDS = new Set(CATALOG.map((v) => v.id));

/** Resolve a stored voiceId to a valid Deepgram voice short name: pass current
 *  catalog ids through, else fall back to the default (guards empty/unknown ids).
 *  Sent to Vapi's "deepgram" provider + /api/tts. */
export function deepgramVoiceFor(voiceId: string | undefined | null): string {
  if (voiceId && CATALOG_VOICE_IDS.has(voiceId)) return voiceId;
  return DEFAULT_VOICE_ID;
}

/** The voice catalog for a specific provider: Deepgram's fixed Aura-2 set, or the
 *  live ElevenLabs premade library (restores the pre-Deepgram behaviour). */
export async function getVoiceCatalogFor(provider: VoiceProvider): Promise<CatalogVoice[]> {
  return provider === "elevenlabs" ? getElevenLabsCatalog() : CATALOG;
}

/** The universal default agent voice — a warm female ElevenLabs voice (Sarah). Every
 *  new agent starts here and stays here until the owner changes it in the AI Brain.
 *  (Same id as DEFAULT_ELEVENLABS_VOICE, inlined to avoid a forward reference.) */
export const DEFAULT_AGENT_VOICE_ID = "EXAVITQu4vr4xnSDxMaL"; // Sarah (ElevenLabs premade)

/** Which provider a voiceId belongs to — a Deepgram catalog name → "deepgram"; any
 *  other non-empty id is an ElevenLabs voice_id → "elevenlabs"; empty → ElevenLabs
 *  (the default voice's provider). Both providers run side-by-side via Vapi; the id
 *  itself decides which engine plays it, so no toggle is needed. */
export function providerForVoiceId(voiceId: string | undefined | null): VoiceProvider {
  const v = (voiceId ?? "").trim();
  if (!v) return "elevenlabs";
  return CATALOG_VOICE_IDS.has(v) ? "deepgram" : "elevenlabs";
}

/* ------------------------------ ElevenLabs voices ------------------------- *
 *  When the admin flips the global voice-provider toggle to ElevenLabs, we drive
 *  the picker from ElevenLabs' *premade* voice library (fetched live from their
 *  API, cached) — exactly as the app did before the Deepgram migration. Premade
 *  ids are account-stable, so the same id plays both in our preview (our
 *  ElevenLabs key) and on the live agent (Vapi's "11labs" provider). Voices the
 *  user picks in this mode store the real ElevenLabs voice_id verbatim.
 * -------------------------------------------------------------------------- */

/** The voice used when nothing else resolves in ElevenLabs mode (a premade id). */
export const DEFAULT_ELEVENLABS_VOICE = "EXAVITQu4vr4xnSDxMaL"; // Sarah (ElevenLabs premade)

/** Legacy map: a *stored Deepgram* voiceId (from a config saved in Deepgram mode)
 *  → a close ElevenLabs premade, so an agent that hasn't re-picked in ElevenLabs
 *  mode still speaks a sensible voice instead of the default for everyone. */
const LEGACY_DEEPGRAM_TO_ELEVEN: Record<string, string> = {
  theia: "EXAVITQu4vr4xnSDxMaL", // Sarah
  hyperion: "JBFqnCBsd6RMkjVDRZzb", // George
  pandora: "FGY2WhTYpPnrIDTdsKH5", // Laura
  draco: "IKne3meq5aSn9XLyUdCD", // Charlie
  thalia: "EXAVITQu4vr4xnSDxMaL", // Sarah
  apollo: "CwhRBWXzGAHq8TQ4Fs17", // Roger
};

/** Resolve a stored voiceId to an ElevenLabs voice_id for the "11labs" provider +
 *  /api/tts. Three cases: (1) empty → default; (2) a legacy Deepgram catalog name
 *  → its mapped premade (or default); (3) anything else is already a real
 *  ElevenLabs voice_id (picked from the ElevenLabs catalog) → passed through. */
export function elevenLabsVoiceFor(voiceId: string | undefined | null): string {
  const v = (voiceId ?? "").trim();
  if (!v) return DEFAULT_ELEVENLABS_VOICE;
  if (CATALOG_VOICE_IDS.has(v)) return LEGACY_DEEPGRAM_TO_ELEVEN[v] ?? DEFAULT_ELEVENLABS_VOICE;
  return v;
}

/** Fallback ElevenLabs catalog when their API isn't reachable / no key — keeps the
 *  picker working with stable premade ids that also play on Vapi. */
const ELEVENLABS_FALLBACK: CatalogVoice[] = [
  { id: "EXAVITQu4vr4xnSDxMaL", name: "Sarah", descriptor: "Mature, Reassuring, Confident", region: "American", previewUrl: null, gender: "female" },
  { id: "CwhRBWXzGAHq8TQ4Fs17", name: "Roger", descriptor: "Laid-Back, Casual, Resonant", region: "American", previewUrl: null, gender: "male" },
  { id: "FGY2WhTYpPnrIDTdsKH5", name: "Laura", descriptor: "Enthusiast, Quirky Attitude", region: "American", previewUrl: null, gender: "female" },
  { id: "IKne3meq5aSn9XLyUdCD", name: "Charlie", descriptor: "Deep, Confident, Energetic", region: "Australian", previewUrl: null, gender: "male" },
  { id: "JBFqnCBsd6RMkjVDRZzb", name: "George", descriptor: "Warm, Mature, Storyteller", region: "British", previewUrl: null, gender: "male" },
];

interface ElevenVoice {
  voice_id: string;
  name: string;
  category?: string;
  preview_url?: string;
  labels?: Record<string, string>;
}

const ELEVEN_CACHE_TTL_MS = 10 * 60 * 1000;
/** Hard ceiling on the upstream call. Past this we serve the cached/fallback list
 *  rather than leaving the picker spinning. */
const ELEVEN_FETCH_TIMEOUT_MS = 8_000;
let elevenCache: { at: number; voices: CatalogVoice[] } | null = null;
/** The in-flight refresh, so concurrent callers share one ElevenLabs request. */
let elevenInflight: Promise<CatalogVoice[]> | null = null;

/* --------------------------- Curated extra voices ------------------------- *
 *  ElevenLabs' *premade* library (what /v1/voices returns, above) carries no
 *  Chinese and no Punjabi voice, and only one Australian — so those groups are
 *  pinned here by voice_id.
 *  Every id is already in our ElevenLabs account and verified on Vapi, so it plays
 *  in /api/tts and on the live agent exactly like a premade id does.
 *
 *  Pinned, not discovered, on purpose: the ids are stable, nothing is imported into
 *  the ElevenLabs account at runtime, and the catalog can't drift between boots.
 *  Each voice's name/description/preview is read from the live /v1/voices response
 *  when present — we never invent a persona name for a voice we can't see.
 *
 *  To add a voice: drop its id in the right group. To add a language: add a spec and
 *  a preview line in src/hooks/useVoicePreview.ts (PREVIEW_LINES).
 * -------------------------------------------------------------------------- */

interface CuratedVoiceSpec {
  /** ISO 639-1 code — tags the voice so the picker can preview it in its own
   *  language and (for Punjabi) route TTS to Eleven v3. */
  language: string;
  /** The picker group these land in — overrides the voice's own accent label. */
  region: string;
  /** Human name of the language, used only for a fallback display label. */
  label: string;
  /** Pinned ElevenLabs voice ids. `name` is the display name — pinned voices
   *  aren't always visible in /v1/voices, so relying on the account lookup can
   *  leave them with "Hindi Female 1"-style fallbacks. `gender` is optional —
   *  when omitted it's read from the account's own label. `descriptor` overrides
   *  the account's description label — some account voices carry a paragraph-long
   *  description that would flood the picker. `language` overrides the spec
   *  language for one voice — used in the Indian group, where ElevenLabs
   *  verifies some voices as English-India ("en") and others as Hindi ("hi"),
   *  so each previews in the language it actually carries. */
  voiceIds: {
    id: string;
    name?: string;
    gender?: "male" | "female";
    descriptor?: string;
    language?: string;
  }[];
  /** Kept out of the picker while still fully configured. Flip to re-enable the
   *  group in one line — nothing else needs changing. */
  hidden?: boolean;
}

const CURATED_VOICE_SPECS: CuratedVoiceSpec[] = [
  // Extra AUSTRALIAN voices (the brand accent) joining premade Charlie. All are
  // professional Voice-Library voices added to our ElevenLabs account, so their
  // ids play in /api/tts and on Vapi exactly like premade ids do.
  {
    language: "en",
    region: "Australian",
    label: "Australian",
    voiceIds: [
      { id: "tyepWYJJwJM9TTFIg5U7", name: "Clara", gender: "female", descriptor: "Warm & Confident" },
      { id: "gEdKKVxVhNCulBgRQ9GW", name: "Charlotte", gender: "female", descriptor: "Clear & Welcoming" },
      { id: "snyKKuaGYk1VUEh42zbW", name: "Oliver", gender: "male", descriptor: "Friendly & Professional" },
      { id: "9B2Vd5yQ7rKaqNmzGdy1", name: "Steve", gender: "male", descriptor: "Deep & Trustworthy" },
    ],
  },
  // A new CHINESE group in the picker.
  {
    language: "zh",
    region: "Chinese",
    label: "Chinese",
    voiceIds: [
      { id: "4NQthjVhIGGVfL3Si000", gender: "female" },
      { id: "bZtjnyJAFD0Cp3lfNG5g", gender: "male" },
    ],
  },
  // Hindi + Indian-English voices head the INDIAN group. All are Voice-Library
  // voices added to our account, and all speak BOTH Hindi and Indian-accented
  // English on the default turbo v2.5 model — no special model routing needed.
  // Per-voice `language` mirrors what ElevenLabs verified each voice as
  // (verified_languages): "en" → English-India voices preview in English;
  // the rest inherit the spec's "hi" and preview with the Hinglish line.
  {
    language: "hi",
    region: "Indian",
    label: "Hindi",
    voiceIds: [
      { id: "8GP6ihnH7Itwx8V1VRX4", name: "Saavi", gender: "female", language: "en" },
      { id: "9KNgJIPXVBUCumG7X8qT", name: "Monika", gender: "female" },
      { id: "9FTUWXd0yHJL1ZiZ71RK", name: "Anika", gender: "female", language: "en" },
      { id: "aScXqoGnNOyGvIIcxgOT", name: "Riya", gender: "female", language: "en" },
      { id: "amiAXapsDOAiHJqbsAZj", name: "Priya", gender: "female" },
      { id: "S15VOp4nJ1AQyaVSHPi6", name: "Raju", gender: "male", language: "en" },
      { id: "oH8YmZXJYEZq5ScgoGn9", name: "Aakash", gender: "male", language: "en" },
      { id: "lqkTesyv03OJNQMxMYow", name: "Niraj", gender: "male" },
      { id: "fPIfC3elMLbN9tNwMXkw", name: "Viraj", gender: "male", language: "en" },
      { id: "SV61h9yhBg4i91KIBwdz", name: "Amit", gender: "male", language: "en" },
    ],
  },
  // Punjabi joins the existing INDIAN group rather than forming a group of one.
  // Ids verified working — they resolve as Jaskirat / Pind Waali Desi Punjabi Voice.
  // Hidden for now (kept fully configured) — remove `hidden` to bring the Punjabi
  // voices back in the picker + admin Voice Bank. Pairs with the Punjabi language
  // being commented out in agentConfig.ts SUPPORTED_AGENT_LANGUAGES.
  {
    language: "pa",
    region: "Indian",
    label: "Punjabi",
    hidden: true,
    voiceIds: [
      { id: "fBXc7vfuym7wUXyB57Eo", gender: "male" },
      { id: "RxnH5jCRKb1ez2lcmQC1", gender: "male" },
    ],
  },
  // Nepali gets its own group — it's a separate country and language, not an
  // Indian regional accent, and grouping it under "Indian" would mislabel it in
  // the picker.
  {
    language: "ne",
    region: "Nepali",
    label: "Nepali",
    voiceIds: [{ id: "qEvUQh8PxrzNFap49hNm" }],
  },
];

/** Voices that only sound right on Eleven v3, keyed by the ISO code of the
 *  language they carry. Turbo v2.5 doesn't render these convincingly.
 *
 *  Static (derived from the specs above), so the model routing is correct
 *  immediately — no catalog fetch has to have happened first. */
const V3_VOICE_LANGUAGES: readonly string[] = ["pa", "ne"];

const V3_VOICE_IDS = new Set(
  CURATED_VOICE_SPECS.filter((s) => V3_VOICE_LANGUAGES.includes(s.language)).flatMap((s) =>
    s.voiceIds.map((v) => v.id),
  ),
);

/** The curated Chinese + Punjabi voices, enriched from our ElevenLabs account.
 *  `accountVoices` is the raw /v1/voices list (all categories — these come back as
 *  "generated"/"cloned", not "premade", which is why they need pinning at all).
 *  A voice missing from that list still appears, under a plain fallback label — a
 *  visible signal that the id isn't reachable with the configured API key. */
function getCuratedExtraVoices(accountVoices: ElevenVoice[]): CatalogVoice[] {
  const byId = new Map(accountVoices.map((v) => [v.voice_id, v]));

  return CURATED_VOICE_SPECS.filter((s) => !s.hidden).flatMap((spec) => {
    // Number the fallback labels only when a group has several of the same gender,
    // so two male Punjabi voices don't both read "Punjabi Male".
    const genderCounts = new Map<string, number>();
    for (const p of spec.voiceIds) {
      const g = (p.gender ?? "").toLowerCase();
      genderCounts.set(g, (genderCounts.get(g) ?? 0) + 1);
    }
    const seen = new Map<string, number>();

    return spec.voiceIds.map((pin, i) => {
      const account = byId.get(pin.id);
      const fromAccount = account ? splitElevenName(account.name).name : "";
      const gender = (pin.gender ?? account?.labels?.gender ?? "").toLowerCase();
      // Pinned name wins (curated ids aren't always visible in /v1/voices), then
      // the account's own name. Never invent one: fall back to a plain label.
      let name = pin.name ?? fromAccount;
      if (!name) {
        if (gender === "male" || gender === "female") {
          const word = gender === "male" ? "Male" : "Female";
          const n = (seen.get(gender) ?? 0) + 1;
          seen.set(gender, n);
          name =
            (genderCounts.get(gender) ?? 0) > 1
              ? `${spec.label} ${word} ${n}`
              : `${spec.label} ${word}`;
        } else {
          name = `${spec.label} Voice ${i + 1}`;
        }
      }

      // The language tag shown in the picker follows the voice's own (possibly
      // overridden) language — an English-India voice reads "English", not "Hindi".
      const language = pin.language ?? spec.language;
      const langLabel = pin.language === "en" ? "English" : spec.label;

      return {
        id: pin.id,
        name,
        descriptor: pin.descriptor ?? (account?.labels?.description?.trim() || langLabel),
        region: spec.region,
        previewUrl: account?.preview_url ?? null,
        gender: gender === "male" || gender === "female" ? gender : null,
        language,
      };
    });
  });
}

function titleCase(s: string): string {
  return s.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()).trim();
}

/** ElevenLabs names are often "Roger - Laid-Back, Casual" — split the trailing
 *  descriptor off the display name so the picker reads cleanly. */
function splitElevenName(raw: string): { name: string; descriptor: string } {
  const [name, ...rest] = raw.split(" - ");
  return { name: name.trim(), descriptor: rest.join(" - ").trim() };
}

function describeEleven(
  rawName: string,
  labels: Record<string, string> = {},
): { name: string; descriptor: string; region: string } {
  const { name, descriptor: fromName } = splitElevenName(rawName);
  const fromLabel = labels.description ? titleCase(labels.description) : "";
  const useCase = labels.use_case ? titleCase(labels.use_case) : "";
  const descriptor = fromName || fromLabel || useCase || "Natural";
  const region = labels.accent ? titleCase(labels.accent) : "Other";
  return { name, descriptor, region };
}

/** The ElevenLabs premade voice library, normalised for the picker.
 *
 *  Fast path by design — this sits in front of the AI-Brain voice picker, so it must
 *  never make a user wait on ElevenLabs:
 *   - fresh cache → returned immediately;
 *   - STALE cache → returned immediately AND refreshed in the background, so only
 *     the very first caller after a boot ever pays the network cost (previously
 *     every request that crossed the 10-minute expiry blocked on a full fetch);
 *   - concurrent cold calls share ONE in-flight fetch. /api/voices resolves the
 *     catalog three times per request (entitlement + current voice + the list), which
 *     on a cold cache fired three simultaneous ElevenLabs requests.
 *
 *  Falls back to a small stable set when the key is missing or the API is unreachable. */
export async function getElevenLabsCatalog(): Promise<CatalogVoice[]> {
  if (elevenCache) {
    const stale = Date.now() - elevenCache.at >= ELEVEN_CACHE_TTL_MS;
    if (stale) void refreshElevenLabsCatalog(); // fire-and-forget; serve the old list now
    return elevenCache.voices;
  }
  return refreshElevenLabsCatalog();
}

/** Refresh the cache, collapsing concurrent callers onto a single fetch. */
function refreshElevenLabsCatalog(): Promise<CatalogVoice[]> {
  if (!elevenInflight) {
    elevenInflight = fetchElevenLabsCatalog();
    void elevenInflight.finally(() => {
      elevenInflight = null;
    });
  }
  return elevenInflight;
}

async function fetchElevenLabsCatalog(): Promise<CatalogVoice[]> {
  const apiKey = getEffective("elevenlabs.apiKey");
  if (!apiKey) return ELEVENLABS_FALLBACK;

  try {
    const resp = await traceFetch("elevenlabs", "https://api.elevenlabs.io/v1/voices", {
      headers: { "xi-api-key": apiKey },
      // Never let a hung upstream hold the picker on "Loading voices…" forever.
      signal: AbortSignal.timeout(ELEVEN_FETCH_TIMEOUT_MS),
    });
    if (!resp.ok) return elevenCache?.voices ?? ELEVENLABS_FALLBACK;

    const data = (await resp.json()) as { voices?: ElevenVoice[] };
    const accountVoices = data.voices ?? [];
    const voices = accountVoices
      // Premade (shared library) voices have account-stable ids that also work on
      // Vapi's ElevenLabs; cloned/professional voices are account-private.
      .filter((v) => (v.category ?? "premade") === "premade")
      .map<CatalogVoice>((v) => {
        const { name, descriptor, region } = describeEleven(v.name, v.labels);
        const rawGender = (v.labels?.gender ?? "").toLowerCase();
        return {
          id: v.voice_id,
          name,
          descriptor,
          region,
          previewUrl: v.preview_url ?? null,
          gender: rawGender === "male" || rawGender === "female" ? rawGender : null,
        };
      });

    // Chinese + Punjabi aren't in the premade set — they're pinned by id.
    const curated = getCuratedExtraVoices(accountVoices);

    // A curated voice that also happens to be premade would otherwise show twice —
    // the curated entry wins (it carries the forced region + language).
    const curatedIds = new Set(curated.map((v) => v.id));
    const premade = voices.filter((v) => !curatedIds.has(v.id));

    const catalog = premade.length || curated.length ? [...premade, ...curated] : ELEVENLABS_FALLBACK;
    elevenCache = { at: Date.now(), voices: catalog };
    return catalog;
  } catch {
    return elevenCache?.voices ?? ELEVENLABS_FALLBACK;
  }
}

/* ------------------------- Eleven v3 model routing ------------------------- *
 *  Turbo v2.5 doesn't carry every language convincingly. The voices that need a
 *  different TTS model are listed above (V3_VOICE_LANGUAGES); a call switches to
 *  Eleven v3 only when the agent is on one of those voices AND has the matching
 *  language enabled. Every other voice/language pair keeps eleven_turbo_v2_5
 *  (cheaper + lower latency) exactly as before.
 * -------------------------------------------------------------------------- */

export const ELEVEN_DEFAULT_MODEL = "eleven_turbo_v2_5";
export const ELEVEN_V3_MODEL = "eleven_v3";

/** Agent-language names (as stored in identity.languages) whose curated voices
 *  need Eleven v3. Keyed by the spec's ISO code so the two stay aligned. */
const V3_LANGUAGE_NAMES: Record<string, string> = {
  pa: "Punjabi",
  ne: "Nepali",
};

/** Is this one of the pinned voices that needs Eleven v3? Answered from the
 *  static spec above, so it's correct without any catalog fetch having happened. */
export function needsElevenV3Voice(voiceId: string | undefined | null): boolean {
  return V3_VOICE_IDS.has((voiceId ?? "").trim());
}

/** The ElevenLabs TTS model for a voice + the agent's enabled languages. Eleven v3
 *  only when a v3 voice is paired with the language it was pinned for; everything
 *  else stays on turbo. */
export function elevenLabsModelFor(
  voiceId: string | undefined | null,
  languages: readonly string[] = [],
): string {
  const id = (voiceId ?? "").trim();
  const spec = CURATED_VOICE_SPECS.find((s) => s.voiceIds.some((v) => v.id === id));
  const languageName = spec ? V3_LANGUAGE_NAMES[spec.language] : undefined;
  return languageName && languages.includes(languageName)
    ? ELEVEN_V3_MODEL
    : ELEVEN_DEFAULT_MODEL;
}


/** Ids of the current ElevenLabs catalog — used to validate a stored/selected id
 *  (unknown → default). */
export async function elevenLabsVoiceIds(): Promise<Set<string>> {
  return new Set((await getElevenLabsCatalog()).map((v) => v.id));
}

/* ------------------------------ Voice gender ----------------------------- *
 *  Used to pick a gender-matched default assistant name at onboarding (e.g. a
 *  male voice → "Mark", a female voice → "Jessica"; the two names are
 *  admin-configurable). Covers the headline onboarding voices (LANDING_VOICES),
 *  the always-on default (Sarah), and the offline fallback catalog. A voice not
 *  listed here returns null → the caller keeps its existing default name.
 *  NOTE: when adding a new landing/onboarding voice, add its gender here too. */
const VOICE_GENDER: Record<string, "male" | "female"> = {
  // Headline landing voices (see src/data/voices.ts → LANDING_VOICES).
  XrExE9yKIg1WjnnlVkGX: "female", // Matilda
  FGY2WhTYpPnrIDTdsKH5: "female", // Laura
  IKne3meq5aSn9XLyUdCD: "male", // Charlie
  JBFqnCBsd6RMkjVDRZzb: "male", // George
  EXAVITQu4vr4xnSDxMaL: "female", // Sarah (the default agent voice)
  // Curated Deepgram Aura-2 voices — kept for gender-matched naming coverage.
  thalia: "female",
  andromeda: "female",
  electra: "female",
  phoebe: "female",
  theia: "female",
  hyperion: "male",
  pandora: "female",
  draco: "male",
  // Legacy / offline fallback catalog voices.
  ys3XeJJA4ArWMhRpcX1D: "female", // Emma
  snyKKuaGYk1VUEh42zbW: "male", // Jack
  "56bWURjYFHyYyVf490Dp": "female", // Alice
  YLbQE9U7P1K6rBNJWNSv: "male", // Charlie (thick Aussie)
  CwhRBWXzGAHq8TQ4Fs17: "male", // Roger
};

/** Resolve a voice's gender, or null when unknown (caller keeps its default). */
export function voiceGender(voiceId: string | undefined | null): "male" | "female" | null {
  if (!voiceId) return null;
  return VOICE_GENDER[voiceId] ?? null;
}

/** Like voiceGender, but also consults the live ElevenLabs catalog's gender
 *  labels — so Voice Bank picks (any premade voice, not just the headline set)
 *  can drive a gender-matched default name. Null when still unknown. */
export async function voiceGenderResolved(
  voiceId: string | undefined | null,
): Promise<"male" | "female" | null> {
  const v = (voiceId ?? "").trim();
  if (!v) return null;
  const known = VOICE_GENDER[v];
  if (known) return known;
  if (providerForVoiceId(v) !== "elevenlabs") return null;
  const voice = (await getElevenLabsCatalog()).find((x) => x.id === v);
  return voice?.gender ?? null;
}

/** Validate + resolve a voiceId against the *live* ElevenLabs catalog. A valid
 *  ElevenLabs id passes through; a legacy Deepgram name is mapped; anything
 *  unknown → the default premade. Used at save time so stored configs self-heal. */
export async function resolveElevenLabsVoiceId(voiceId: string | undefined | null): Promise<string> {
  const v = (voiceId ?? "").trim();
  if (v && (await elevenLabsVoiceIds()).has(v)) return v;
  return elevenLabsVoiceFor(v);
}

/** Defensive parse of a Json string[] column (voiceIds / allowedVoices). */
export function voiceIdList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((x): x is string => typeof x === "string");
}

/* ------------------------------ Voice Bank -------------------------------- *
 *  Voices are curated into admin-defined categories (VoiceCategory). A plan points
 *  at one category; its customers may pick any voice in that category from the AI
 *  Brain. There's no per-voice lock UI — a user simply sees the voices they can use.
 *  Everyone starts on the default voice (Sarah) and can change it once they're on a
 *  plan (trialing or active) whose plan has a category. Admins can pick any voice
 *  from either provider.
 * -------------------------------------------------------------------------- */

export interface VoiceAccess {
  /** AI-Brain voice picker unlocked? (plan with a category — trialing or active — or admin) */
  canChange: boolean;
  /** The voice ids the user may select (their plan's category, or all for admins). */
  voiceIds: string[];
  isAdmin: boolean;
  /** Category title (for display) when on a plan (trialing or active) with one. */
  categoryTitle: string | null;
  planName: string | null;
}

/** Resolve what voices a user may choose. No-plan / plan-without-category → locked
 *  (canChange:false, empty list) so they stay on the default voice. A plan with a
 *  category, whether trialing or active, unlocks that category's voices — a trial
 *  is a faithful preview of the plan it's trialing, voices included. Admin → every
 *  voice. */
export async function getUserVoiceAccess(userId: string): Promise<VoiceAccess> {
  // The platform's own people have no workspace: an admin among them gets
  // every voice. A brand account is read from its brand's database; the plan
  // it names is the platform's catalogue.
  const brandId = await brandIdForOwner(userId);
  const tenantProfile = brandId
    ? await (await tenantFor(brandId)).profile.findUnique({
        where: { userId },
        select: { receptionistNumber: true, subscriptionPlanId: true, user: { select: { role: true } } },
      })
    : null;
  const platformRole = brandId
    ? null
    : ((await prisma.user.findUnique({ where: { id: userId }, select: { role: true } }))?.role ?? null);
  const subscriptionPlan = tenantProfile?.subscriptionPlanId
    ? await prisma.subscriptionPlan.findUnique({
        where: { id: tenantProfile.subscriptionPlanId },
        select: { displayName: true, voiceCategory: { select: { title: true, voiceIds: true } } },
      })
    : null;
  const profile = tenantProfile ? { ...tenantProfile, subscriptionPlan } : null;

  if (isAdminRole(profile?.user?.role ?? platformRole)) {
    const [dg, el] = await Promise.all([
      getVoiceCatalogFor("deepgram"),
      getVoiceCatalogFor("elevenlabs"),
    ]);
    return {
      canChange: true,
      voiceIds: [...dg, ...el].map((v) => v.id),
      isAdmin: true,
      categoryTitle: null,
      planName: null,
    };
  }

  // NO restrictions through the whole trial/setup — until the user goes live by
  // claiming a dedicated number, they can pick ANY voice as a full taste of the
  // product. Once a number is assigned they're committed to their chosen plan, so
  // that plan's voice category applies from then on.
  const hasNumber = Boolean(profile?.receptionistNumber?.trim());
  if (!hasNumber) {
    const [dg, el] = await Promise.all([
      getVoiceCatalogFor("deepgram"),
      getVoiceCatalogFor("elevenlabs"),
    ]);
    return {
      canChange: true,
      voiceIds: [...dg, ...el].map((v) => v.id),
      isAdmin: false,
      categoryTitle: "Free trial",
      planName: "Free Trial",
    };
  }

  // Live on a plan → only that plan's Voice Bank category is selectable.
  const category = profile?.subscriptionPlan?.voiceCategory;
  const ids = category ? voiceIdList(category.voiceIds) : [];
  return {
    canChange: ids.length > 0,
    voiceIds: ids,
    isAdmin: false,
    categoryTitle: category ? category.title : null,
    planName: profile?.subscriptionPlan?.displayName ?? null,
  };
}

/** May this user set their agent to `voiceId`? The default voice is always allowed
 *  (everyone keeps it); otherwise it must be in their entitled set. */
export async function canSelectVoice(userId: string, voiceId: string): Promise<boolean> {
  if (voiceId === DEFAULT_AGENT_VOICE_ID) return true;
  const access = await getUserVoiceAccess(userId);
  return access.isAdmin || access.voiceIds.includes(voiceId);
}

/** Resolve voice ids (across BOTH providers) to catalog entries, preserving order
 *  and dropping any id no longer in either catalog. Each carries its provider. */
export async function resolveVoices(
  ids: string[],
): Promise<(CatalogVoice & { provider: VoiceProvider })[]> {
  const [dg, el] = await Promise.all([
    getVoiceCatalogFor("deepgram"),
    getVoiceCatalogFor("elevenlabs"),
  ]);
  const byId = new Map<string, CatalogVoice>();
  for (const v of dg) byId.set(v.id, v);
  for (const v of el) byId.set(v.id, v);
  return ids
    .map((id) => byId.get(id))
    .filter((v): v is CatalogVoice => Boolean(v))
    .map((v) => ({ ...v, provider: providerForVoiceId(v.id) }));
}
