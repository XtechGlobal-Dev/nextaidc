import {
  TRANSCRIBER_PROVIDERS,
  transcriberOptionsSnapshot,
  type TranscriberOption,
} from "../lib/transcribers.js";

// Transcriber model lists refreshed from Vapi's OpenAPI schema (same idea as vapiModels.ts).
// Providers and language support stay curated — the schema doesn't say what a provider can hear.

const OPENAPI_URL = "https://api.vapi.ai/api-json";
const TTL_MS = 6 * 60 * 60 * 1000; // re-fetch at most every 6h
const FETCH_TIMEOUT_MS = 8000;

type Schemas = Record<
  string,
  { properties?: { model?: { enum?: string[]; anyOf?: { enum?: string[] }[] } } }
>;

// Free-text (Deepgram) or model-less (AssemblyAI) providers have no enum; they keep the curated list.
function liveModelsFor(schemas: Schemas, schemaName: string): string[] {
  const prop = schemas[schemaName]?.properties?.model;
  if (!prop) return [];
  if (prop.enum) return prop.enum;
  if (prop.anyOf) return prop.anyOf.flatMap((a) => a.enum ?? []);
  return [];
}

let cache: { at: number; options: TranscriberOption[] } | null = null;
let inFlight: Promise<TranscriberOption[]> | null = null;

async function fetchLive(): Promise<TranscriberOption[]> {
  const res = await fetch(OPENAPI_URL, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`Vapi schema ${res.status}`);
  const schemas = ((await res.json()) as { components?: { schemas?: Schemas } }).components?.schemas;
  if (!schemas) throw new Error("Vapi schema missing components.schemas");

  // Overlay live enums on the curated snapshot so the dropdown never goes empty.
  return transcriberOptionsSnapshot().map((opt) => {
    const def = TRANSCRIBER_PROVIDERS.find((p) => p.id === opt.provider);
    const live = def ? liveModelsFor(schemas, def.fallbackSchema) : [];
    return live.length ? { ...opt, models: live } : opt;
  });
}

/** Transcriber options for the admin dropdown. Cached; falls back to last-good or the bundled snapshot so the UI never breaks. `force` bypasses the cache. */
export async function getTranscriberOptions(force = false): Promise<TranscriberOption[]> {
  if (!force && cache && Date.now() - cache.at < TTL_MS) return cache.options;
  if (inFlight) return inFlight;
  inFlight = fetchLive()
    .then((options) => {
      cache = { at: Date.now(), options };
      return options;
    })
    .catch(() => cache?.options ?? transcriberOptionsSnapshot())
    .finally(() => {
      inFlight = null;
    });
  return inFlight;
}
