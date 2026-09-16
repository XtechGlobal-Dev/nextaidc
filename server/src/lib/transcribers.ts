// STT fallback catalogue + Vapi fallbackPlan builder (Vapi has no "auto" flag, so we pick the backup).
// A fallback that can't hear the agent's tier is skipped — confident nonsense is worse than a clean failure.

/** Coverage tier: "en", "multi" (Deepgram nova-3 multi set), "wide" (beyond — only Google today). */
export type TranscriberTier = "en" | "multi" | "wide";

/** Per-provider tier shape: most take `language`; Soniox takes `languages` where `[]` = auto-detect. */
export type TierLanguage = { language: string } | { languages: string[] };

/** A transcriber provider we let an admin choose as a fallback. */
export interface TranscriberProviderDef {
  /** Vapi provider id, sent verbatim in the payload. */
  id: string;
  /** Human label for the dropdown. */
  label: string;
  /** OpenAPI schema name for its Fallback variant — used by the live "Refresh
   *  from Vapi" pull to update this provider's model enum. */
  fallbackSchema: string;
  /** Curated model ids (first = default). Empty when the provider takes no model
   *  field (e.g. AssemblyAI). Live refresh may replace this for enum-backed ones. */
  models: string[];
  /** How to ask each tier the provider can serve. A tier ABSENT here means the
   *  provider can't transcribe it → never used as a fallback for that tier. */
  lang: Partial<Record<TranscriberTier, TierLanguage>>;
}

/** Only providers verifiable against Vapi's OpenAPI schema, so a saved fallback never 400s a sync. Order = display order. */
export const TRANSCRIBER_PROVIDERS: TranscriberProviderDef[] = [
  {
    id: "deepgram",
    label: "Deepgram",
    fallbackSchema: "FallbackDeepgramTranscriber",
    models: ["nova-3", "nova-2"],
    lang: { en: { language: "en" }, multi: { language: "multi" } },
  },
  {
    id: "google",
    label: "Google",
    fallbackSchema: "FallbackGoogleTranscriber",
    models: ["gemini-2.5-flash", "gemini-2.0-flash"],
    lang: { en: { language: "English" }, multi: { language: "Multilingual" }, wide: { language: "Multilingual" } },
  },
  {
    id: "assembly-ai",
    label: "AssemblyAI",
    fallbackSchema: "FallbackAssemblyAITranscriber",
    models: [],
    lang: { en: { language: "en" }, multi: { language: "multi" } },
  },
  {
    id: "openai",
    label: "OpenAI",
    fallbackSchema: "FallbackOpenAITranscriber",
    models: ["gpt-4o-transcribe", "gpt-4o-mini-transcribe"],
    lang: { en: { language: "en" } },
  },
  {
    // Soniox is wide-capable (185 languages); multilingual is `languages: []` (auto-detect), hence the array form.
    id: "soniox",
    label: "Soniox",
    fallbackSchema: "FallbackSonioxTranscriber",
    models: ["stt-rt-v5", "stt-rt-v4"],
    lang: { en: { language: "en" }, multi: { languages: [] }, wide: { languages: [] } },
  },
];

/** The provider that serves as the PRIMARY for a tier (so an auto-pick never just
 *  re-picks the primary). Mirrors transcriberFor() in agentConfig.ts. */
export function primaryProviderForTier(tier: TranscriberTier): string {
  return tier === "wide" ? "google" : "deepgram";
}

export function findTranscriberProvider(id: string | undefined | null): TranscriberProviderDef | undefined {
  return TRANSCRIBER_PROVIDERS.find((p) => p.id === id);
}

/** A single Vapi fallback transcriber object (goes in fallbackPlan.transcribers).
 *  Carries either a single `language` or a `languages` array, per the provider. */
export interface VapiFallbackTranscriber {
  provider: string;
  model?: string;
  language?: string;
  languages?: string[];
}

/** Build one fallback transcriber for a provider+model at a given tier, or null
 *  when that provider can't hear the tier (the safety skip). */
export function buildFallbackTranscriber(
  providerId: string,
  model: string | undefined,
  tier: TranscriberTier,
): VapiFallbackTranscriber | null {
  const def = findTranscriberProvider(providerId);
  if (!def) return null;
  const tierLang = def.lang[tier];
  if (!tierLang) return null; // provider can't transcribe this tier → skip (safety)
  const chosen = def.models.length ? model?.trim() || def.models[0] : "";
  return { provider: def.id, ...(chosen ? { model: chosen } : {}), ...tierLang };
}

/** The admin's saved fallback preference. */
export interface TranscriberFallbackSetting {
  /** When true, we also auto-pick a capable backup (in addition to any manual one). */
  autoFallback: boolean;
  /** Admin's preferred fallback provider ("" = none). */
  provider: string;
  /** Preferred model ("" = provider default / not applicable). */
  model: string;
}

export interface VapiTranscriberFallbackPlan {
  transcribers: VapiFallbackTranscriber[];
}

/** Vapi `fallbackPlan` for a tier: manual preference first, then one auto-picked capable backup.
 *  Incapable providers and the primary are skipped; null when nothing applies. */
export function buildTranscriberFallbackPlan(
  setting: TranscriberFallbackSetting,
  tier: TranscriberTier,
): VapiTranscriberFallbackPlan | null {
  const primary = primaryProviderForTier(tier);
  const used = new Set<string>([primary]);
  const transcribers: VapiFallbackTranscriber[] = [];

  // 1) Admin's manual preferred fallback (if capable + not the primary).
  if (setting.provider && setting.provider !== primary) {
    const manual = buildFallbackTranscriber(setting.provider, setting.model, tier);
    if (manual) {
      transcribers.push(manual);
      used.add(manual.provider);
    }
  }

  // 2) Auto-picked capable backup — the first curated provider that can hear the
  //    tier and isn't already used (primary or the manual choice).
  if (setting.autoFallback) {
    for (const p of TRANSCRIBER_PROVIDERS) {
      if (used.has(p.id)) continue;
      const auto = buildFallbackTranscriber(p.id, undefined, tier);
      if (auto) {
        transcribers.push(auto);
        used.add(p.id);
        break;
      }
    }
  }

  return transcribers.length ? { transcribers } : null;
}

/** Options shape returned to the admin UI dropdown. */
export interface TranscriberOption {
  provider: string;
  label: string;
  models: string[];
  /** Tiers this provider can serve — lets the UI hint multilingual coverage. */
  tiers: TranscriberTier[];
}

/** The curated snapshot as UI options (live refresh merges model enums on top). */
export function transcriberOptionsSnapshot(): TranscriberOption[] {
  return TRANSCRIBER_PROVIDERS.map((p) => ({
    provider: p.id,
    label: p.label,
    models: p.models,
    tiers: Object.keys(p.lang) as TranscriberTier[],
  }));
}

/** Whether (provider, model) is a valid choice in the current options. An empty
 *  model is valid for a provider that takes no model field. */
export function isKnownTranscriber(
  options: TranscriberOption[],
  provider: string,
  model: string,
): boolean {
  const opt = options.find((o) => o.provider === provider);
  if (!opt) return false;
  if (!model) return opt.models.length === 0 || true; // model optional
  return opt.models.includes(model);
}
