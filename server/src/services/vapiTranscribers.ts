import {
  TRANSCRIBER_PROVIDERS,
  transcriberOptionsSnapshot,
  type TranscriberOption,
} from "../lib/transcribers.js";

/* ------------------------------------------------------------------ *
 *  Live transcriber-model catalogue — model lists pulled from Vapi.
 *
 *  Same approach as vapiModels.ts (the LLM list): Vapi's public OpenAPI
 *  schema (https://api.vapi.ai/api-json) holds each Fallback<Provider>
 *  transcriber's `model` enum. We refresh the model lists for our curated
 *  providers from it so the admin dropdown stays current without a
 *  redeploy, while the PROVIDER set + language capability stay curated
 *  (the schema doesn't say which languages a provider can actually hear).
 *
 *  Cached in memory (TTL) with a single in-flight fetch; falls back to the
 *  bundled snapshot whenever Vapi is unreachable or returns nothing.
 * ------------------------------------------------------------------ */

const OPENAPI_URL = "https://api.vapi.ai/api-json";
const TTL_MS = 6 * 60 * 60 * 1000; // re-fetch at most every 6h
const FETCH_TIMEOUT_MS = 8000;

type Schemas = Record<
  string,
  { properties?: { model?: { enum?: string[]; anyOf?: { enum?: string[] }[] } } }
>;

/** Model ids for a provider's Fallback schema, when it exposes a fixed enum.
 *  Providers whose model is free-text (Deepgram) or absent (AssemblyAI) have no
 *  enum — we keep their curated list for those. */
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

  // Start from the curated snapshot and overlay live model enums where present —
  // keeping the curated models for free-text/no-model providers so the dropdown
  // never goes empty.
  return transcriberOptionsSnapshot().map((opt) => {
    const def = TRANSCRIBER_PROVIDERS.find((p) => p.id === opt.provider);
    const live = def ? liveModelsFor(schemas, def.fallbackSchema) : [];
    return live.length ? { ...opt, models: live } : opt;
  });
}

/**
 * Transcriber options for the admin dropdown (model lists refreshed from Vapi).
 * Cached for TTL_MS; concurrent callers share one fetch. On any failure returns
 * the last good cache, else the bundled snapshot — so the admin UI never breaks.
 * Pass `force` to bypass the cache (the admin "Refresh from Vapi" button).
 */
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
