import { AGENT_LLM_OPTIONS, type AgentLlmOption } from "../lib/agentConfig.js";

/* ------------------------------------------------------------------ *
 *  Live LLM catalogue — providers + models pulled from Vapi at runtime.
 *
 *  The provider/model list is fetched LIVE from Vapi's public OpenAPI schema
 *  (https://api.vapi.ai/api-json) so the admin dropdown always reflects Vapi's
 *  current catalogue without a redeploy. Result is cached in memory (TTL) with a
 *  single in-flight fetch, and falls back to the bundled snapshot
 *  (AGENT_LLM_OPTIONS) whenever Vapi is unreachable or returns nothing.
 *
 *  Cost/min + latency are NOT exposed by any Vapi API — they live only in Vapi's
 *  dashboard bundle. We therefore merge them in from the bundled snapshot (keep
 *  it fresh with `node scripts/syncVapiModels.mjs`). A live model with no snapshot
 *  entry simply shows without a cost/latency badge.
 * ------------------------------------------------------------------ */

const OPENAPI_URL = "https://api.vapi.ai/api-json";
const TTL_MS = 6 * 60 * 60 * 1000; // re-fetch at most every 6h
const FETCH_TIMEOUT_MS = 8000;

/** Providers we surface + the OpenAPI schema that holds each one's model enum.
 *  Providers whose model is free-text (no fixed enum) are intentionally omitted. */
const PROVIDERS: { id: string; label: string; schema: string }[] = [
  { id: "anthropic", label: "Anthropic", schema: "AnthropicModel" },
  { id: "openai", label: "OpenAI", schema: "OpenAIModel" },
  { id: "google", label: "Google", schema: "GoogleModel" },
  { id: "groq", label: "Groq", schema: "GroqModel" },
  { id: "xai", label: "xAI", schema: "XaiModel" },
  { id: "deep-seek", label: "DeepSeek", schema: "DeepSeekModel" },
  { id: "cerebras", label: "Cerebras", schema: "CerebrasModel" },
  { id: "anthropic-bedrock", label: "Anthropic (AWS Bedrock)", schema: "AnthropicBedrockModel" },
  { id: "inflection-ai", label: "Inflection AI", schema: "InflectionAIModel" },
  { id: "minimax", label: "MiniMax", schema: "MinimaxLLMModel" },
];

/** cost/latency snapshot keyed by `${provider}|${model}` (from the bundled list). */
const META = new Map(
  AGENT_LLM_OPTIONS.map((o) => [`${o.provider}|${o.model}`, { costPerMin: o.costPerMin, latencyMs: o.latencyMs }]),
);

type Schemas = Record<string, { properties?: { model?: { enum?: string[]; anyOf?: { enum?: string[] }[] } } }>;

/** Model ids for a provider from the OpenAPI schema, minus the noise variants. */
function modelsFor(schemas: Schemas, provider: (typeof PROVIDERS)[number]): string[] {
  const prop = schemas[provider.schema]?.properties?.model;
  let m: string[] = [];
  if (prop?.enum) m = prop.enum;
  else if (prop?.anyOf) for (const a of prop.anyOf) if (a.enum) m = m.concat(a.enum);
  // Drop OpenAI's Azure region-pinned (":region") and realtime variants, and
  // Google realtime variants — none belong in a voice-agent LLM dropdown.
  if (provider.id === "openai") m = m.filter((x) => !x.includes(":") && !x.includes("realtime"));
  if (provider.id === "google") m = m.filter((x) => !x.includes("realtime"));
  return m;
}

let cache: { at: number; options: AgentLlmOption[] } | null = null;
let inFlight: Promise<AgentLlmOption[]> | null = null;

async function fetchLive(): Promise<AgentLlmOption[]> {
  const res = await fetch(OPENAPI_URL, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`Vapi schema ${res.status}`);
  const schemas = ((await res.json()) as { components?: { schemas?: Schemas } }).components?.schemas;
  if (!schemas) throw new Error("Vapi schema missing components.schemas");

  const out: AgentLlmOption[] = [];
  for (const p of PROVIDERS) {
    for (const model of modelsFor(schemas, p)) {
      const meta = META.get(`${p.id}|${model}`) ?? { costPerMin: null, latencyMs: null };
      out.push({ provider: p.id, model, label: model, providerLabel: p.label, ...meta });
    }
  }
  if (!out.length) throw new Error("Vapi schema yielded no models");
  return out;
}

/**
 * Live provider/model catalogue (cost/latency merged from the snapshot).
 * Cached for TTL_MS; concurrent callers share one fetch. On any failure returns
 * the last good cache, else the bundled snapshot — so the admin UI never breaks.
 * Pass `force` to bypass the cache (the admin "Refresh from Vapi" button).
 */
export async function getAgentLlmOptions(force = false): Promise<AgentLlmOption[]> {
  if (!force && cache && Date.now() - cache.at < TTL_MS) return cache.options;
  if (inFlight) return inFlight;
  inFlight = fetchLive()
    .then((options) => {
      cache = { at: Date.now(), options };
      return options;
    })
    .catch(() => cache?.options ?? AGENT_LLM_OPTIONS)
    .finally(() => {
      inFlight = null;
    });
  return inFlight;
}

/** True when (provider, model) is in the live catalogue (falls back to snapshot). */
export async function isKnownAgentLlm(provider: string, model: string): Promise<boolean> {
  const options = await getAgentLlmOptions();
  return options.some((o) => o.provider === provider && o.model === model);
}
