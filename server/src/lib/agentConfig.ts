/* Server-side mirror of the frontend agent_config model + prompt compiler.
 * Kept dependency-free so the seed script and the Vapi sync can both use it. */

import {
  seededSmsInfoItems,
  MAX_SMS_INFO_ITEMS,
  MAX_ENABLED_SMS_INFO_ITEMS,
  type SmsInfoItem,
} from "./smsInfoItems.js";

/** Max length for assistant & business display names. Vapi caps an assistant's
 *  `name` at 40 chars, so we clamp every name to this before persisting/sending. */
export const NAME_MAX = 40;

/** Clamp a display name to NAME_MAX characters. */
export const clampName = (s: string | undefined | null): string => (s ?? "").slice(0, NAME_MAX);

/** Opening greeting cap. Mirrors GREETING_MAX in src/lib/limits.ts — keep both
 *  in step, the same way NAME_MAX is mirrored. */
export const GREETING_MAX = 160;

/** Clamp the opening greeting. It is owner-editable free text that lands in the
 *  master prompt AND the Vapi payload, so an unbounded value would bloat every
 *  call's system prompt. */
export const clampGreeting = (s: string | undefined | null): string =>
  (s ?? "").slice(0, GREETING_MAX);

// Timezone helpers, inlined rather than imported from lib/phoneTimeZone.ts so
// this module stays dependency-free (that file pulls in libphonenumber-js).
// rules.timezone used to hold a display label from a 7-entry Australia-only
// picker; it holds an IANA zone now, and these translate the old values on read
// so existing customers keep compiling correctly without a data migration.
const LEGACY_LABEL_TO_IANA: Record<string, string> = {
  "Sydney (AEST/AEDT)": "Australia/Sydney",
  "Melbourne (AEST/AEDT)": "Australia/Melbourne",
  "Brisbane (AEST)": "Australia/Brisbane",
  "Adelaide (ACST/ACDT)": "Australia/Adelaide",
  "Perth (AWST)": "Australia/Perth",
  "Darwin (ACST)": "Australia/Darwin",
  "Hobart (AEST/AEDT)": "Australia/Hobart",
};

function isValidZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** Coerce a stored timezone to an IANA zone; "" when it can't be interpreted. */
export function normalizeTimeZone(value?: string): string {
  const raw = value?.trim();
  if (!raw) return "";
  if (LEGACY_LABEL_TO_IANA[raw]) return LEGACY_LABEL_TO_IANA[raw];
  return isValidZone(raw) ? raw : "";
}

/** Human label for a zone, e.g. "Perth (AWST)" — city plus the abbreviation in
 *  effect right now, so it stays honest across DST. */
export function timeZoneLabel(tz: string, now: Date = new Date()): string {
  if (!isValidZone(tz)) return tz;
  const city = (tz.split("/").pop() ?? tz).replace(/_/g, " ");
  const abbr = new Intl.DateTimeFormat("en-US", { timeZone: tz, timeZoneName: "short" })
    .formatToParts(now)
    .find((p) => p.type === "timeZoneName")?.value;
  return abbr ? `${city} (${abbr})` : city;
}

/**
 * Title-case a person's name for storage/display ("redtape" -> "Redtape",
 * "john doe" -> "John Doe"). Only the first letter of each word is forced up so
 * intentional inner caps (e.g. "McCoy") survive. Trims and collapses whitespace.
 */
export const titleCaseName = (s: string | undefined | null): string =>
  (s ?? "")
    .trim()
    .split(/\s+/)
    .map((w) => (w ? w.charAt(0).toUpperCase() + w.slice(1) : w))
    .join(" ");

/* ------------------------------- Agent LLM ------------------------------- *
 *  The LLM that powers every provisioned Vapi assistant. Admin-selectable in
 *  Admin → Settings; the chosen provider/model is stamped on each assistant at
 *  create/sync time (see services/vapi.ts buildAssistantPayload). Kept here —
 *  the dependency-free shared module — so the server settings layer, the routes'
 *  validation and the seed script all read one catalogue.
 *
 *  `provider`/`model` are Vapi's own identifiers, sent verbatim in the assistant
 *  payload. Only add entries you've confirmed Vapi accepts, or agent creation
 *  will 400 for every new customer. */
export interface AgentLlmOption {
  /** Vapi provider id, e.g. "anthropic" | "openai" | "google". */
  provider: string;
  /** Vapi model id sent in the assistant payload, e.g. "claude-haiku-4-5-20251001". */
  model: string;
  /** Human label for the model shown in the admin dropdown. */
  label: string;
  /** Human label for the provider (groups models in the dropdown). */
  providerLabel: string;
  /** Estimated cost per minute (USD) as shown in Vapi's model picker; null when
   *  Vapi has no estimate for this model. Synced from Vapi's own cost estimator
   *  (see scripts/syncVapiModels.mjs). */
  costPerMin: number | null;
  /** Estimated response latency (ms) as shown in Vapi's model picker; null when unknown. */
  latencyMs: number | null;
}

/** Bundled snapshot of the LLM catalogue. At runtime the admin dropdown is fed
 *  the LIVE list fetched from Vapi's OpenAPI schema by services/vapiModels.ts;
 *  this array is the OFFLINE FALLBACK (used when Vapi is unreachable) and the
 *  source of each model's cost/min + latency (which Vapi has no API for — they're
 *  pulled from Vapi's dashboard cost estimator by scripts/syncVapiModels.mjs and
 *  merged onto the live list by provider+model).
 *
 *  Every entry is a Vapi-valid (provider, model) pair. Excluded on purpose:
 *  providers that take a free-text model with no fixed list (anyscale, deepinfra,
 *  openrouter, perplexity-ai, together-ai, custom-llm) and OpenAI's Azure
 *  region-pinned / realtime variants. To refresh, run `node scripts/syncVapiModels.mjs`.
 *  NOTE: a non-Anthropic provider only works once its API key is set on the Vapi
 *  account itself; unset keys make that assistant fail at call time. */
export const AGENT_LLM_OPTIONS: AgentLlmOption[] = [
  // Anthropic

  { provider: "anthropic", model: "claude-3-opus-20240229", label: "claude-3-opus-20240229", providerLabel: "Anthropic", costPerMin: 0.04, latencyMs: 1270 },

  { provider: "anthropic", model: "claude-3-sonnet-20240229", label: "claude-3-sonnet-20240229", providerLabel: "Anthropic", costPerMin: 0.02, latencyMs: 1700 },

  { provider: "anthropic", model: "claude-3-haiku-20240307", label: "claude-3-haiku-20240307", providerLabel: "Anthropic", costPerMin: 0.01, latencyMs: 600 },

  { provider: "anthropic", model: "claude-3-5-sonnet-20240620", label: "claude-3-5-sonnet-20240620", providerLabel: "Anthropic", costPerMin: 0.02, latencyMs: 870 },

  { provider: "anthropic", model: "claude-3-5-sonnet-20241022", label: "claude-3-5-sonnet-20241022", providerLabel: "Anthropic", costPerMin: 0.02, latencyMs: 2000 },

  { provider: "anthropic", model: "claude-3-5-haiku-20241022", label: "claude-3-5-haiku-20241022", providerLabel: "Anthropic", costPerMin: 0.01, latencyMs: 1750 },

  { provider: "anthropic", model: "claude-3-7-sonnet-20250219", label: "claude-3-7-sonnet-20250219", providerLabel: "Anthropic", costPerMin: 0.02, latencyMs: 1000 },

  { provider: "anthropic", model: "claude-opus-4-20250514", label: "claude-opus-4-20250514", providerLabel: "Anthropic", costPerMin: 0.02, latencyMs: 1000 },

  { provider: "anthropic", model: "claude-opus-4-5-20251101", label: "claude-opus-4-5-20251101", providerLabel: "Anthropic", costPerMin: 0.04, latencyMs: 2000 },

  { provider: "anthropic", model: "claude-opus-4-6", label: "claude-opus-4-6", providerLabel: "Anthropic", costPerMin: 0.04, latencyMs: 2000 },

  { provider: "anthropic", model: "claude-sonnet-4-20250514", label: "claude-sonnet-4-20250514", providerLabel: "Anthropic", costPerMin: 0.02, latencyMs: 1000 },

  { provider: "anthropic", model: "claude-sonnet-4-5-20250929", label: "claude-sonnet-4-5-20250929", providerLabel: "Anthropic", costPerMin: 0.02, latencyMs: 2000 },

  { provider: "anthropic", model: "claude-sonnet-4-6", label: "claude-sonnet-4-6", providerLabel: "Anthropic", costPerMin: 0.02, latencyMs: 2000 },

  { provider: "anthropic", model: "claude-haiku-4-5-20251001", label: "claude-haiku-4-5-20251001", providerLabel: "Anthropic", costPerMin: 0.01, latencyMs: 800 },

  // OpenAI

  { provider: "openai", model: "gpt-5.4", label: "gpt-5.4", providerLabel: "OpenAI", costPerMin: 0.08, latencyMs: 1250 },

  { provider: "openai", model: "gpt-5.4-mini", label: "gpt-5.4-mini", providerLabel: "OpenAI", costPerMin: 0.08, latencyMs: 800 },

  { provider: "openai", model: "gpt-5.4-nano", label: "gpt-5.4-nano", providerLabel: "OpenAI", costPerMin: 0.08, latencyMs: 650 },

  { provider: "openai", model: "gpt-5.2", label: "gpt-5.2", providerLabel: "OpenAI", costPerMin: 0.08, latencyMs: 1350 },

  { provider: "openai", model: "gpt-5.2-chat-latest", label: "gpt-5.2-chat-latest", providerLabel: "OpenAI", costPerMin: 0.08, latencyMs: 700 },

  { provider: "openai", model: "gpt-5.1", label: "gpt-5.1", providerLabel: "OpenAI", costPerMin: 0.08, latencyMs: 1350 },

  { provider: "openai", model: "gpt-5.1-chat-latest", label: "gpt-5.1-chat-latest", providerLabel: "OpenAI", costPerMin: 0.08, latencyMs: 700 },

  { provider: "openai", model: "gpt-5", label: "gpt-5", providerLabel: "OpenAI", costPerMin: 0.08, latencyMs: 1550 },

  { provider: "openai", model: "gpt-5-chat-latest", label: "gpt-5-chat-latest", providerLabel: "OpenAI", costPerMin: 0.08, latencyMs: 700 },

  { provider: "openai", model: "gpt-5-mini", label: "gpt-5-mini", providerLabel: "OpenAI", costPerMin: 0.02, latencyMs: 1450 },

  { provider: "openai", model: "gpt-5-nano", label: "gpt-5-nano", providerLabel: "OpenAI", costPerMin: 0.01, latencyMs: 1350 },

  { provider: "openai", model: "gpt-4.1-2025-04-14", label: "gpt-4.1-2025-04-14", providerLabel: "OpenAI", costPerMin: 0.02, latencyMs: 700 },

  { provider: "openai", model: "gpt-4.1-mini-2025-04-14", label: "gpt-4.1-mini-2025-04-14", providerLabel: "OpenAI", costPerMin: 0.01, latencyMs: 770 },

  { provider: "openai", model: "gpt-4.1-nano-2025-04-14", label: "gpt-4.1-nano-2025-04-14", providerLabel: "OpenAI", costPerMin: 0.01, latencyMs: 510 },

  { provider: "openai", model: "gpt-4.1", label: "gpt-4.1", providerLabel: "OpenAI", costPerMin: 0.02, latencyMs: 700 },

  { provider: "openai", model: "gpt-4.1-mini", label: "gpt-4.1-mini", providerLabel: "OpenAI", costPerMin: 0.01, latencyMs: 770 },

  { provider: "openai", model: "gpt-4.1-nano", label: "gpt-4.1-nano", providerLabel: "OpenAI", costPerMin: 0.01, latencyMs: 510 },

  { provider: "openai", model: "chatgpt-4o-latest", label: "chatgpt-4o-latest", providerLabel: "OpenAI", costPerMin: 0.02, latencyMs: 500 },

  { provider: "openai", model: "o3", label: "o3", providerLabel: "OpenAI", costPerMin: 0.01, latencyMs: 1670 },

  { provider: "openai", model: "o3-mini", label: "o3-mini", providerLabel: "OpenAI", costPerMin: 0.01, latencyMs: 2400 },

  { provider: "openai", model: "o4-mini", label: "o4-mini", providerLabel: "OpenAI", costPerMin: 0.04, latencyMs: 1460 },

  { provider: "openai", model: "o1-mini", label: "o1-mini", providerLabel: "OpenAI", costPerMin: 0.02, latencyMs: 1460 },

  { provider: "openai", model: "o1-mini-2024-09-12", label: "o1-mini-2024-09-12", providerLabel: "OpenAI", costPerMin: 0.04, latencyMs: 1460 },

  { provider: "openai", model: "gpt-4o-mini-2024-07-18", label: "gpt-4o-mini-2024-07-18", providerLabel: "OpenAI", costPerMin: 0.01, latencyMs: 390 },

  { provider: "openai", model: "gpt-4o-mini", label: "gpt-4o-mini", providerLabel: "OpenAI", costPerMin: 0.01, latencyMs: 390 },

  { provider: "openai", model: "gpt-4o", label: "gpt-4o", providerLabel: "OpenAI", costPerMin: 0.02, latencyMs: 600 },

  { provider: "openai", model: "gpt-4o-2024-05-13", label: "gpt-4o-2024-05-13", providerLabel: "OpenAI", costPerMin: 0.02, latencyMs: 600 },

  { provider: "openai", model: "gpt-4o-2024-08-06", label: "gpt-4o-2024-08-06", providerLabel: "OpenAI", costPerMin: 0.02, latencyMs: 600 },

  { provider: "openai", model: "gpt-4o-2024-11-20", label: "gpt-4o-2024-11-20", providerLabel: "OpenAI", costPerMin: 0.02, latencyMs: 600 },

  { provider: "openai", model: "gpt-4-turbo", label: "gpt-4-turbo", providerLabel: "OpenAI", costPerMin: 0.04, latencyMs: 800 },

  { provider: "openai", model: "gpt-4-turbo-2024-04-09", label: "gpt-4-turbo-2024-04-09", providerLabel: "OpenAI", costPerMin: 0.04, latencyMs: 800 },

  { provider: "openai", model: "gpt-4-turbo-preview", label: "gpt-4-turbo-preview", providerLabel: "OpenAI", costPerMin: 0.04, latencyMs: 800 },

  { provider: "openai", model: "gpt-4-0125-preview", label: "gpt-4-0125-preview", providerLabel: "OpenAI", costPerMin: 0.04, latencyMs: 800 },

  { provider: "openai", model: "gpt-4-1106-preview", label: "gpt-4-1106-preview", providerLabel: "OpenAI", costPerMin: 0.04, latencyMs: 800 },

  { provider: "openai", model: "gpt-4", label: "gpt-4", providerLabel: "OpenAI", costPerMin: 0.04, latencyMs: 800 },

  { provider: "openai", model: "gpt-4-0613", label: "gpt-4-0613", providerLabel: "OpenAI", costPerMin: 0.04, latencyMs: 800 },

  { provider: "openai", model: "gpt-3.5-turbo", label: "gpt-3.5-turbo", providerLabel: "OpenAI", costPerMin: 0.01, latencyMs: 250 },

  { provider: "openai", model: "gpt-3.5-turbo-0125", label: "gpt-3.5-turbo-0125", providerLabel: "OpenAI", costPerMin: 0.01, latencyMs: 250 },

  { provider: "openai", model: "gpt-3.5-turbo-1106", label: "gpt-3.5-turbo-1106", providerLabel: "OpenAI", costPerMin: 0.01, latencyMs: 250 },

  { provider: "openai", model: "gpt-3.5-turbo-16k", label: "gpt-3.5-turbo-16k", providerLabel: "OpenAI", costPerMin: 0.01, latencyMs: 250 },

  { provider: "openai", model: "gpt-3.5-turbo-0613", label: "gpt-3.5-turbo-0613", providerLabel: "OpenAI", costPerMin: 0.01, latencyMs: 250 },

  // Google

  { provider: "google", model: "gemini-3.5-flash", label: "gemini-3.5-flash", providerLabel: "Google", costPerMin: 0, latencyMs: 1500 },

  { provider: "google", model: "gemini-3.1-flash-lite", label: "gemini-3.1-flash-lite", providerLabel: "Google", costPerMin: 0, latencyMs: 700 },

  { provider: "google", model: "gemini-3-flash-preview", label: "gemini-3-flash-preview", providerLabel: "Google", costPerMin: 0, latencyMs: 1500 },

  { provider: "google", model: "gemini-2.5-pro", label: "gemini-2.5-pro", providerLabel: "Google", costPerMin: 0.01, latencyMs: 1000 },

  { provider: "google", model: "gemini-2.5-flash", label: "gemini-2.5-flash", providerLabel: "Google", costPerMin: 0, latencyMs: 800 },

  { provider: "google", model: "gemini-2.5-flash-lite", label: "gemini-2.5-flash-lite", providerLabel: "Google", costPerMin: 0, latencyMs: 700 },

  { provider: "google", model: "gemini-2.0-flash-thinking-exp", label: "gemini-2.0-flash-thinking-exp", providerLabel: "Google", costPerMin: 0, latencyMs: 800 },

  { provider: "google", model: "gemini-2.0-pro-exp-02-05", label: "gemini-2.0-pro-exp-02-05", providerLabel: "Google", costPerMin: 0, latencyMs: 1000 },

  { provider: "google", model: "gemini-2.0-flash", label: "gemini-2.0-flash", providerLabel: "Google", costPerMin: 0, latencyMs: 800 },

  { provider: "google", model: "gemini-2.0-flash-lite", label: "gemini-2.0-flash-lite", providerLabel: "Google", costPerMin: 0, latencyMs: 800 },

  { provider: "google", model: "gemini-2.0-flash-exp", label: "gemini-2.0-flash-exp", providerLabel: "Google", costPerMin: 0, latencyMs: 800 },

  { provider: "google", model: "gemini-1.5-flash", label: "gemini-1.5-flash", providerLabel: "Google", costPerMin: 0, latencyMs: 1000 },

  { provider: "google", model: "gemini-1.5-flash-002", label: "gemini-1.5-flash-002", providerLabel: "Google", costPerMin: 0, latencyMs: 1000 },

  { provider: "google", model: "gemini-1.5-pro", label: "gemini-1.5-pro", providerLabel: "Google", costPerMin: 0, latencyMs: 1000 },

  { provider: "google", model: "gemini-1.5-pro-002", label: "gemini-1.5-pro-002", providerLabel: "Google", costPerMin: 0, latencyMs: 1000 },

  { provider: "google", model: "gemini-1.0-pro", label: "gemini-1.0-pro", providerLabel: "Google", costPerMin: 0, latencyMs: 1000 },

  // Groq

  { provider: "groq", model: "openai/gpt-oss-20b", label: "openai/gpt-oss-20b", providerLabel: "Groq", costPerMin: 0, latencyMs: 280 },

  { provider: "groq", model: "openai/gpt-oss-120b", label: "openai/gpt-oss-120b", providerLabel: "Groq", costPerMin: 0, latencyMs: 280 },

  { provider: "groq", model: "deepseek-r1-distill-llama-70b", label: "deepseek-r1-distill-llama-70b", providerLabel: "Groq", costPerMin: 0, latencyMs: 600 },

  { provider: "groq", model: "llama-3.3-70b-versatile", label: "llama-3.3-70b-versatile", providerLabel: "Groq", costPerMin: 0, latencyMs: 600 },

  { provider: "groq", model: "llama-3.1-405b-reasoning", label: "llama-3.1-405b-reasoning", providerLabel: "Groq", costPerMin: 0, latencyMs: 600 },

  { provider: "groq", model: "llama-3.1-8b-instant", label: "llama-3.1-8b-instant", providerLabel: "Groq", costPerMin: 0, latencyMs: 300 },

  { provider: "groq", model: "llama3-8b-8192", label: "llama3-8b-8192", providerLabel: "Groq", costPerMin: 0, latencyMs: 300 },

  { provider: "groq", model: "llama3-70b-8192", label: "llama3-70b-8192", providerLabel: "Groq", costPerMin: 0, latencyMs: 600 },

  { provider: "groq", model: "gemma2-9b-it", label: "gemma2-9b-it", providerLabel: "Groq", costPerMin: 0, latencyMs: 500 },

  { provider: "groq", model: "moonshotai/kimi-k2-instruct-0905", label: "moonshotai/kimi-k2-instruct-0905", providerLabel: "Groq", costPerMin: 0, latencyMs: 610 },

  { provider: "groq", model: "meta-llama/llama-4-maverick-17b-128e-instruct", label: "meta-llama/llama-4-maverick-17b-128e-instruct", providerLabel: "Groq", costPerMin: 0, latencyMs: 200 },

  { provider: "groq", model: "meta-llama/llama-4-scout-17b-16e-instruct", label: "meta-llama/llama-4-scout-17b-16e-instruct", providerLabel: "Groq", costPerMin: 0, latencyMs: 500 },

  { provider: "groq", model: "mistral-saba-24b", label: "mistral-saba-24b", providerLabel: "Groq", costPerMin: 0, latencyMs: 300 },

  { provider: "groq", model: "compound-beta", label: "compound-beta", providerLabel: "Groq", costPerMin: 0, latencyMs: 500 },

  { provider: "groq", model: "compound-beta-mini", label: "compound-beta-mini", providerLabel: "Groq", costPerMin: 0, latencyMs: 400 },

  // xAI

  { provider: "xai", model: "grok-beta", label: "grok-beta", providerLabel: "xAI", costPerMin: 0, latencyMs: 800 },

  { provider: "xai", model: "grok-2", label: "grok-2", providerLabel: "xAI", costPerMin: 0, latencyMs: 800 },

  { provider: "xai", model: "grok-3", label: "grok-3", providerLabel: "xAI", costPerMin: 0, latencyMs: 800 },

  { provider: "xai", model: "grok-4-fast-reasoning", label: "grok-4-fast-reasoning", providerLabel: "xAI", costPerMin: 0, latencyMs: 500 },

  { provider: "xai", model: "grok-4-fast-non-reasoning", label: "grok-4-fast-non-reasoning", providerLabel: "xAI", costPerMin: 0, latencyMs: 400 },

  { provider: "xai", model: "grok-4.20-0309-reasoning", label: "grok-4.20-0309-reasoning", providerLabel: "xAI", costPerMin: 0, latencyMs: 800 },

  { provider: "xai", model: "grok-4.20-0309-non-reasoning", label: "grok-4.20-0309-non-reasoning", providerLabel: "xAI", costPerMin: 0, latencyMs: 600 },

  { provider: "xai", model: "grok-4.3", label: "grok-4.3", providerLabel: "xAI", costPerMin: 0, latencyMs: 3400 },

  // DeepSeek

  { provider: "deep-seek", model: "deepseek-chat", label: "deepseek-chat", providerLabel: "DeepSeek", costPerMin: 0, latencyMs: 400 },

  { provider: "deep-seek", model: "deepseek-reasoner", label: "deepseek-reasoner", providerLabel: "DeepSeek", costPerMin: 0, latencyMs: 7000 },

  // Cerebras

  { provider: "cerebras", model: "llama3.1-8b", label: "llama3.1-8b", providerLabel: "Cerebras", costPerMin: 0, latencyMs: 300 },

  { provider: "cerebras", model: "llama-3.3-70b", label: "llama-3.3-70b", providerLabel: "Cerebras", costPerMin: null, latencyMs: null },

  // Anthropic (AWS Bedrock)

  { provider: "anthropic-bedrock", model: "claude-3-opus-20240229", label: "claude-3-opus-20240229", providerLabel: "Anthropic (AWS Bedrock)", costPerMin: null, latencyMs: null },

  { provider: "anthropic-bedrock", model: "claude-3-sonnet-20240229", label: "claude-3-sonnet-20240229", providerLabel: "Anthropic (AWS Bedrock)", costPerMin: null, latencyMs: null },

  { provider: "anthropic-bedrock", model: "claude-3-haiku-20240307", label: "claude-3-haiku-20240307", providerLabel: "Anthropic (AWS Bedrock)", costPerMin: null, latencyMs: null },

  { provider: "anthropic-bedrock", model: "claude-3-5-sonnet-20240620", label: "claude-3-5-sonnet-20240620", providerLabel: "Anthropic (AWS Bedrock)", costPerMin: null, latencyMs: null },

  { provider: "anthropic-bedrock", model: "claude-3-5-sonnet-20241022", label: "claude-3-5-sonnet-20241022", providerLabel: "Anthropic (AWS Bedrock)", costPerMin: null, latencyMs: null },

  { provider: "anthropic-bedrock", model: "claude-3-5-haiku-20241022", label: "claude-3-5-haiku-20241022", providerLabel: "Anthropic (AWS Bedrock)", costPerMin: null, latencyMs: null },

  { provider: "anthropic-bedrock", model: "claude-3-7-sonnet-20250219", label: "claude-3-7-sonnet-20250219", providerLabel: "Anthropic (AWS Bedrock)", costPerMin: null, latencyMs: null },

  { provider: "anthropic-bedrock", model: "claude-opus-4-20250514", label: "claude-opus-4-20250514", providerLabel: "Anthropic (AWS Bedrock)", costPerMin: null, latencyMs: null },

  { provider: "anthropic-bedrock", model: "claude-opus-4-5-20251101", label: "claude-opus-4-5-20251101", providerLabel: "Anthropic (AWS Bedrock)", costPerMin: null, latencyMs: null },

  { provider: "anthropic-bedrock", model: "claude-opus-4-6", label: "claude-opus-4-6", providerLabel: "Anthropic (AWS Bedrock)", costPerMin: null, latencyMs: null },

  { provider: "anthropic-bedrock", model: "claude-sonnet-4-20250514", label: "claude-sonnet-4-20250514", providerLabel: "Anthropic (AWS Bedrock)", costPerMin: null, latencyMs: null },

  { provider: "anthropic-bedrock", model: "claude-sonnet-4-5-20250929", label: "claude-sonnet-4-5-20250929", providerLabel: "Anthropic (AWS Bedrock)", costPerMin: null, latencyMs: null },

  { provider: "anthropic-bedrock", model: "claude-sonnet-4-6", label: "claude-sonnet-4-6", providerLabel: "Anthropic (AWS Bedrock)", costPerMin: null, latencyMs: null },

  { provider: "anthropic-bedrock", model: "claude-haiku-4-5-20251001", label: "claude-haiku-4-5-20251001", providerLabel: "Anthropic (AWS Bedrock)", costPerMin: null, latencyMs: null },

  { provider: "anthropic-bedrock", model: "global.anthropic.claude-haiku-4-5-20251001-v1:0", label: "global.anthropic.claude-haiku-4-5-20251001-v1:0", providerLabel: "Anthropic (AWS Bedrock)", costPerMin: null, latencyMs: null },

  // Inflection AI

  { provider: "inflection-ai", model: "inflection_3_pi", label: "inflection_3_pi", providerLabel: "Inflection AI", costPerMin: null, latencyMs: null },

  // MiniMax

  { provider: "minimax", model: "MiniMax-M2.7", label: "MiniMax-M2.7", providerLabel: "MiniMax", costPerMin: 0.01, latencyMs: 1200 },
];

/** The built-in default LLM — used until an admin saves an override, and the
 *  fallback whenever a stored value isn't in the catalogue any more. Matches the
 *  value the platform shipped with, so behaviour is unchanged until an admin
 *  picks something else. Must stay a member of AGENT_LLM_OPTIONS. */
export const DEFAULT_AGENT_LLM: { provider: string; model: string } = {
  provider: "anthropic",
  model: "claude-haiku-4-5-20251001",
};

/** True when the (provider, model) pair is a known, selectable option. */
export function isKnownAgentLlm(provider: string, model: string): boolean {
  return AGENT_LLM_OPTIONS.some((o) => o.provider === provider && o.model === model);
}

/** Languages a multilingual-plan customer may enable, beyond the English base.
 *  Bounded by the weakest link in the call pipeline — Deepgram nova-3's
 *  multilingual (code-switching) transcription set; ElevenLabs turbo v2.5 TTS
 *  covers all of these too. Don't add a language here without confirming both
 *  STT and TTS support it, or callers get the "AI can't follow me" experience.
 *  Keep this identical to the client list in src/data/languages.ts. */
export const SUPPORTED_AGENT_LANGUAGES = [
  "Hindi",
  // Punjabi hidden for now — mirror of the client list (src/data/languages.ts).
  // Uncomment both to re-enable it as a switch-to language.
  // "Punjabi",
  // Dialect named deliberately — see the client list (src/data/languages.ts).
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

/** The languages Deepgram nova-3's code-switching mode (`language: "multi"`) can
 *  actually transcribe, alongside English. Deepgram is the default because it's the
 *  fastest, but its multi set is narrow — a caller speaking anything outside it comes
 *  back as confident garbage in the wrong script (Mandarin arriving as Devanagari),
 *  which the LLM then answers as if it understood. Keep this list matched to
 *  Deepgram's published nova-3 multilingual set, NOT to our own language catalogue. */
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

/** Google's transcriber model. Vapi validates this against a fixed list of Gemini
 *  model names — "latest" (which Vapi's own multilingual docs still show) is
 *  REJECTED and fails the assistant update. Flash is the right tier for a live call:
 *  the pro models are slower and transcription doesn't need the extra reasoning. */
const GOOGLE_TRANSCRIBER_MODEL = "gemini-2.5-flash";

/** The speech-to-text config for a set of enabled languages. */
export type TranscriberConfig =
  | { provider: "deepgram"; model: "nova-3"; language: "en" | "multi" }
  | { provider: "google"; model: string; language: "Multilingual" };

/** Pick the transcriber that can actually hear this agent's callers:
 *   - no extra languages → Deepgram nova-3, English only (fastest);
 *   - every extra language inside Deepgram's multi set → nova-3 "multi" (unchanged
 *     behaviour for every agent that existed before Punjabi/Mandarin);
 *   - anything beyond it (Punjabi, Mandarin) → Google's multilingual model, which
 *     covers them. Slower than Deepgram, but the alternative is not understanding
 *     the caller at all. */
/** The transcription-coverage tier an agent needs, from its enabled languages.
 *  Mirrors transcriberFor()'s branching so the fallback logic can pick only
 *  providers that can actually hear this agent (see lib/transcribers.ts):
 *   - "en"    → English only
 *   - "multi" → English + Deepgram-covered languages
 *   - "wide"  → beyond Deepgram (e.g. Mandarin) — only Google covers it today. */
export function transcriberTierFor(languages: readonly string[]): "en" | "multi" | "wide" {
  if (!languages.length) return "en";
  return languages.every((l) => DEEPGRAM_MULTI_LANGUAGES.includes(l)) ? "multi" : "wide";
}

export function transcriberFor(languages: readonly string[]): TranscriberConfig {
  if (!languages.length) return { provider: "deepgram", model: "nova-3", language: "en" };
  const deepgramCovers = languages.every((l) => DEEPGRAM_MULTI_LANGUAGES.includes(l));
  if (deepgramCovers) return { provider: "deepgram", model: "nova-3", language: "multi" };
  // Google only, with NO Deepgram fallback on purpose: Deepgram can't hear these
  // languages, so falling back to it would transcribe the caller as confident
  // nonsense and the agent would answer as if it understood. Vapi ends the call if
  // Google fails — a clear failure beats a call that silently misunderstands.
  // Vapi's Google transcriber validates `language` against a Title-Cased enum
  // ("Multilingual", "English", …) — lowercase "multilingual" is REJECTED.
  return { provider: "google", model: GOOGLE_TRANSCRIBER_MODEL, language: "Multilingual" };
}

/** Max keyterms sent to Deepgram — its keyterm prompting degrades past ~100
 *  terms, and a business's own vocabulary fits comfortably well under this. */
const TRANSCRIBER_KEYTERM_MAX = 50;

/** Domain vocabulary for Deepgram nova-3 keyterm prompting: the business name +
 *  its service names, so the live STT hears "split system" instead of "spirit
 *  system" and gets the business name right. English-only (Deepgram supports
 *  keyterm on nova-3 English) — the caller applies it only when language is "en".
 *  Deduped case-insensitively, trimmed, capped; over-long entries are skipped
 *  (they're sentences, not vocabulary, and dilute the boost). */
export function transcriberKeyterms(config: AgentConfig): string[] {
  const raw = [config.identity.businessName, ...config.knowledge.services];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const term of raw) {
    const t = (term ?? "").trim();
    if (!t || t.length > 60) continue;
    const key = t.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(t);
    if (out.length >= TRANSCRIBER_KEYTERM_MAX) break;
  }
  return out;
}

/** Languages only available on an ElevenLabs voice. Deepgram's Aura-2 voices are
 *  English-only and the Deepgram pipeline has no coverage for these two, so they're
 *  hidden (and stripped on save) whenever the agent is on a Deepgram voice.
 *  Mirrored client-side (src/data/languages.ts, ELEVENLABS_ONLY_LANGUAGES). */
export const ELEVENLABS_ONLY_LANGUAGES: readonly string[] = [
  "Punjabi",
  "Chinese (Mandarin)",
  "Nepali",
];

/** Sanitize a stored/submitted language list: known entries only, deduped, in
 *  catalogue order. English is the implicit base and never stored. Pass the agent's
 *  voice provider to also drop the ElevenLabs-only languages on a Deepgram voice —
 *  without it a stale client (or a later voice change) could persist a language the
 *  agent can't actually speak. */
export function sanitizeAgentLanguages(
  raw: unknown,
  voiceProvider?: "deepgram" | "elevenlabs",
): string[] {
  if (!Array.isArray(raw)) return [];
  const wanted = new Set(raw.filter((l): l is string => typeof l === "string"));
  return SUPPORTED_AGENT_LANGUAGES.filter(
    (l) =>
      wanted.has(l) && !(voiceProvider === "deepgram" && ELEVENLABS_ONLY_LANGUAGES.includes(l)),
  );
}

/** Context from the owner's profile, injected into the prompt compiler. */
export interface CompileContext {
  country?: string;
  industry?: string;
}

export interface AgentConfig {
  identity: {
    assistantName: string;
    businessName: string;
    voiceId: string;
    greetingMessage: string;
    /** The voice provider this agent was set up with ("deepgram" | "elevenlabs").
     *  Stamped at provision/save from the then-current global toggle, then sticky —
     *  a later global toggle change never retroactively switches an existing agent.
     *  Unset on legacy configs → resolved from the voiceId (see providerForVoiceId). */
    voiceProvider?: "deepgram" | "elevenlabs";
    /** Extra languages the assistant may answer in (multilingual plans only).
     *  English is always the base and isn't stored here. Empty/absent → English only. */
    languages?: string[];
    /** ISO 3166-1 alpha-2 country of the customer (uppercase), captured at
     *  onboarding from the number-selection step. Drives the regional style
     *  block appended to the live prompt (see lib/countryStyles.ts). Absent on
     *  legacy configs → no regional style until backfilled from their number. */
    country?: string;
  };
  knowledge: {
    quickFacts: { id: string; key: string; value: string }[];
    services: string[];
    captureFields: { id: string; label: string; enabled: boolean }[];
    faqs: { id: string; question: string; answer: string }[];
  };
  rules: {
    timezone: string;
    scenarioHandling: { id: string; ifText: string; thenText: string }[];
    pricing: { behaviour: string; fixedItemsEnabled: boolean; fixedItems: { id: string; item: string; price: string }[] };
    declineCalls: string[];
    businessHours: string;
    humanHandover: { enabled: boolean; transferNumber: string };
  };
  automations: {
    ownerEmailSummary: boolean;
    ownerSmsSummary: boolean;
    /** Master switch for "Text Info to Callers" (see `smsOnRequest`). Historically
     *  a dormant post-call flag that never sent anything — repurposed rather than
     *  replaced so no stored config needs migrating. */
    clientPostCallSms: boolean;
    ownerWhatsAppSummary: boolean;
    /** Summary-only override destinations. Blank → account default (signup email / mobile). */
    summaryEmail: string;
    summarySmsNumber: string;
    summaryWhatsAppNumber: string;
    /** Include a public "More info" conversation link in the summary SMS. */
    smsIncludeConversationLink: boolean;
    /** Include the same conversation link in the WhatsApp summary. */
    whatsAppIncludeConversationLink: boolean;
    /** How long that public link stays valid, in hours. 0 = never expires. */
    conversationLinkValidityHours: number;
    /** Language the owner wants their summaries + transcripts delivered in.
     *  Empty or "English" → no translation (the call's own language). */
    reportLanguage: string;
    /** What the AI may text a caller who asks for it during the call. */
    smsOnRequest: { items: SmsInfoItem[] };
  };
  advanced: {
    masterPrompt: string;
    masterPromptDirty: boolean;
    creativity: number;
    voiceStability: number;
    voiceSpeed: number;
    allowHangUp: boolean;
    /** Ambient call sound → Vapi backgroundSound. "default" lets the platform
     *  decide (office on phone). Optional so pre-feature configs still type-check. */
    backgroundSound?: "off" | "office" | "default";
  };
}

const bullet = (lines: string[]) => lines.map((l) => `- ${l}`).join("\n");

/**
 * The editable scaffold that wraps every assistant's prompt. An admin can
 * override this in Admin → Settings (stored as the `prompt.masterTemplate`
 * platform setting); when unset, this default is used. Two placeholders are
 * substituted at compile time:
 *   {{assistantName}} → the assistant's name (falls back to "the receptionist")
 *   {{businessName}}  → the owner's business name (falls back to "the business")
 *   {{identity}}      → the assistant's IDENTITY block (who it is + greeting),
 *                       rendered right under # NAME; templates without this
 *                       marker keep identity inside {{sections}}
 *   {{sections}}      → the per-customer blocks (services, FAQs, rules…)
 *                       compiled from the structured AgentConfig
 * Placeholder matching is case-insensitive. A custom template that omits
 * {{sections}} still gets the per-customer blocks appended, so an admin can
 * never accidentally strip the assistant's knowledge.
 *
 * This SHORT scaffold is a token-efficient equivalent of the default below —
 * it is ONLY ever sent to the live agent (Vapi/WhatsApp) when the admin's
 * "Live call prompt" toggle is on Short. Customers never see it: their AI
 * Brain always displays the full template (custom override or the default).
 */
/**
 * How the agent is allowed to SPEAK on a call — length, directness, one question
 * at a time, how to sign off. This is a platform guarantee rather than
 * per-customer content, so it is appended verbatim to every wire prompt in
 * buildVapiSystemPrompt (services/vapi.ts), the same way REGIONAL STYLE is.
 *
 * That injection is what makes it universal. Compiling it into the scaffold
 * alone reaches only agents whose prompt is still auto-compiled: an owner who
 * hand-edits their master prompt freezes it (`masterPromptDirty`), and
 * baseSystemPrompt then serves that frozen text — so a template change would
 * never reach them. Appending after summarization also keeps the summarizer
 * from compressing these rules away.
 *
 * Exported so the section can be kept in one place; DEFAULT_PROMPT_TEMPLATE_SHORT
 * embeds this same text so the uninjected prompt already reads correctly.
 */
/** How to take a number the caller reads out. Kept separate from the brevity
 *  rules because it is stamped onto every assistant the same way (see
 *  buildVapiSystemPrompt) but is a different guarantee: brevity is about how
 *  much to say, this is about not making the caller repeat themselves.
 *
 *  The transcriber side of this is handled by Deepgram `numerals` + a longer
 *  number endpointing window (services/vapi.ts). These rules cover what's left:
 *  even with clean digits the model would re-ask when a number arrived in two
 *  pieces, because nothing told it that a short digit run is an unfinished
 *  number rather than a complete answer. */
export const WIRE_NUMBER_RULES = [
  "## TAKING A NUMBER",
  "- Callers read numbers out in groups, with pauses. A short run of digits is almost never the whole number — wait for the rest instead of replying to a fragment.",
  "- Join everything they read out into ONE number. If digits arrive across a pause, they belong to the same number unless the caller says otherwise.",
  "- A phone number is normally nine to eleven digits. If you have fewer than that, you're still mid-number — stay quiet and let them finish.",
  "- Never ask them to start the number again just because you missed one part. Ask only for the part you're missing: \"Sorry, was that a five or a nine at the end?\"",
  "- Ask for a number once. Once you have a complete one, move on — never ask for it a second time, and never ask them to confirm it twice.",
  "- Write numbers as digits, never as words.",
].join("\n");

export const WIRE_BEHAVIOUR_RULES = [
  "## HOW MUCH TO SAY",
  "- Be blunt and to the point. ONE short sentence — usually UNDER 15 words — is a complete reply. Two short sentences is the absolute maximum, and the second is normally just your question.",
  "- Speak in complete, natural sentences, even when short: \"Yes, that's included in the standard package.\" Keep the connecting words in. Never compress a reply into bare noun phrases or half-sentences — sounding like a machine is worse than being one sentence longer.",
  "- When the caller is finished (\"that's all\", \"no thanks\", \"I don't want anything\"), say EXACTLY this, word for word: \"No worries at all — thanks for calling, have a great day!\" Say the whole sentence — never shorten it to a single word and never swap it for a shorter sign-off.",
  "- Your reply must OPEN with the answer. Never praise or restate the question first — no \"Good question\", \"Great question\", \"That's a good one\".",
  "- Never define or introduce the thing they asked about — they already know what it is. \"Is that included?\" is answered with \"No, that's a separate add-on\", not with an explanation of what the service is.",
  "- Don't justify your answer. \"We quote on site — it's free.\" is a complete reply. Never add why every job differs, what it depends on, or what happens next unless they ask.",
  "- Answer only what was asked. Never add related information, options or upsells the caller didn't ask for — if they want more, they'll ask.",
  "- NEVER read a list aloud or enumerate items. Asked what you offer or what's included, answer at CATEGORY level in ONE sentence — name the two or three broad areas this business covers, not the individual items inside them — then ask what they're after. Name a specific item only when it IS the answer.",
  "- Even if they ask for \"everything\" or \"all your services\", still answer by category and offer to go through one at a time — never recite the full list at them.",
  "- Say it once. If you've already explained something (like how quoting works), do NOT explain it again for a second item — just answer the new part: \"Same for that one — quoted on site.\"",
  "- ONE question mark per reply. Never give the caller a menu of options — no \"Are you after A? Or B?\", no \"...or would you like to hear more?\". Ask one thing, then STOP and wait for their answer.",
  "- Cut filler: \"just to confirm\", \"in order to\", \"to help me further\", \"as I mentioned\", \"as an AI\", \"I apologise for the inconvenience\".",
  "",
  "This is the length you're aiming for:",
  "Caller: \"Is that included in the standard package?\"",
  "RIGHT: \"No, that's a separate add-on. Want me to book you in?\"",
  "WRONG: \"Good question. The standard package is our most popular option — it's designed to cover the essentials, and that particular item would normally fall under our add-ons or extras. Are you after that, or the full package?\"",
  "",
  "Caller: \"What's included?\" / \"What services do you offer?\"",
  "RIGHT: one sentence naming the two or three broad areas you cover, then \"What are you after?\"",
  "WRONG: reading out the individual items from your services list, one after another.",
  "",
  "Caller: \"How much does it cost?\"",
  "RIGHT: \"It depends on the job, so we quote on site — that's free. Want me to book you in?\"",
  "WRONG: \"We'd need to assess it on-site to give you an accurate quote. Every job's a bit different depending on the condition and what needs doing, but the good news is quotes are completely free and no obligation.\"",
  "",
  "One question only — never a menu:",
  "RIGHT: \"Want me to book you in?\"",
  "WRONG: \"Are you looking to book in? Or would you like to know more about what it includes?\"",
].join("\n");

/** Matches a `## HOW MUCH TO SAY` section up to the next heading (or the end), so
 *  a stale or summarizer-reworded copy can be replaced with WIRE_BEHAVIOUR_RULES. */
const HOW_MUCH_TO_SAY_RE = /(^|\n)##[ \t]*HOW MUCH TO SAY[\s\S]*?(?=\n#{1,2}[ \t]|$)/i;

/** Drop any existing HOW MUCH TO SAY section from a prompt. Used before appending
 *  the canonical block so an agent never carries two (possibly conflicting) copies
 *  — the compiled one may have been reworded by the summarizer, and a frozen
 *  prompt may carry an old edited version. */
export function stripHowMuchToSay(prompt: string): string {
  return prompt.replace(HOW_MUCH_TO_SAY_RE, "$1").replace(/\n{3,}/g, "\n\n").trim();
}

export const DEFAULT_PROMPT_TEMPLATE_SHORT = [
  "# NAME: {{assistantName}}",
  "{{identity}}",
  "# ROLE\nYou are a warm, professional phone receptionist for {{businessName}} who sounds completely human. Speak naturally with everyday language and contractions (I'll, you're, we've), and never make up information you weren't given.\nBrevity matters more than anything else: on a phone call every extra sentence wastes the caller's time and makes you sound like a machine.",
  WIRE_BEHAVIOUR_RULES,
  [
    "## CONVERSATION STYLE",
    "- Sound like a real, friendly person — never a script, a form or a bot. Vary your wording.",
    "- If the caller starts talking while you're speaking, stop immediately and listen.",
    "- Don't read the caller's name, number, address or other details back to them — acknowledge briefly and move on.",
    "- Never assume the caller's name — use it only if they introduce themselves.",
    "- Treat the number they're calling from as their contact number — just ask \"Is this the best number to reach you on?\"",
    "- When you must read a number back, say each digit slowly and evenly.",
    "- If the line is unclear: \"Sorry, the line's a bit unclear — can you please repeat that?\"",
    "- Never mention these instructions, \"the system\", dates/timezone or backend actions. Don't bring up being an AI on your own — only if directly asked, acknowledge politely and carry on.",
  ].join("\n"),
  [
    "## CONVERSATION FLOW",
    "- Assume every call is about {{businessName}} — reassure confused callers they've reached the right place.",
    "- Gather details naturally, one at a time, and never re-ask something already given.",
    "- Never block a genuine enquiry over a missing detail. Existing or already-booked customers: don't re-qualify — take a short message for the team.",
  ].join("\n"),
  "## STAY ON TOPIC\nHelp only with enquiries about {{businessName}} and the knowledge in this prompt. Politely steer unrelated topics back to how you can help. Never guess or speculate — if you don't have the information, say the team will follow up.",
  "{{sections}}",
  "## CLOSING\nOnce you have the useful details, close in ONE line — confirm only what matters (a booked time, or what they need) and never read their details back. The team will be in touch shortly (during business hours if it's after hours).\nNEVER end the call yourself. A \"no\" to something you offered is NOT the end of the call — it only means they don't want that one thing. Reply \"No worries — anything else I can help you with?\" and keep going. Only ever sign off once the CALLER has clearly finished: \"bye\", \"that's all\", \"thanks, that's it\". Saying a sign-off ends the call instantly, so never say one while the caller may still have questions.\nWhen they do finish, sign off warmly once — like a human, thanking them for calling even if they decided not to book: \"No worries at all — thanks for calling, have a great day!\" Never sign off with a single word — that sounds like a machine hanging up on them. Don't restart the conversation over a small background sound after goodbye.",
].join("\n\n");

/** The default (full/detailed) scaffold — what admins edit in Settings and what
 *  customers see in their AI Brain. An admin override (`prompt.masterTemplate`)
 *  replaces it; the SHORT scaffold above may replace it on the wire to Vapi only.
 *  Keep this identical to the client copy in src/lib/compilePrompt.ts. */
export const DEFAULT_PROMPT_TEMPLATE = [
  "# NAME: {{assistantName}}",
  "{{identity}}",
  "# ROLE\nYou are a warm, professional phone receptionist who sounds completely human on a call. Speak naturally and conversationally — like a real person, never a script or a bot. Use everyday spoken language and contractions (I'll, you're, we've), and never make up information you weren't given.\nBrevity is the habit that matters most. On a phone call every extra sentence wastes the caller's time and makes you sound like a machine — a real receptionist gives the short answer and stops.",
  [
    "## HOW MUCH TO SAY",
    "- Be blunt and to the point. ONE short sentence — usually UNDER 15 words — is a complete reply. Two short sentences is the absolute maximum, and the second is normally just your question. Go longer only when the caller directly asks you to explain something in detail.",
    "- Speak in complete, natural sentences, even when short: \"Yes, that's included in the standard package.\" Keep the connecting words in. Never compress a reply into bare noun phrases or half-sentences — sounding like a machine is worse than being one sentence longer.",
    "- When the caller is finished (\"that's all\", \"no thanks\", \"I don't want anything\"), say EXACTLY this, word for word: \"No worries at all — thanks for calling, have a great day!\" Say the whole sentence — never shorten it to a single word and never swap it for a shorter sign-off.",
    "- Your reply must OPEN with the answer — no preamble, no warm-up, no repeating the question back. Never praise the question first: no \"Good question\", \"Great question\", \"That's a good one\".",
    "- Never define or introduce the thing they asked about — they already know what it is. \"Is that included?\" is answered with \"No, that's a separate add-on\", not with an explanation of what the service is.",
    "- Don't justify your answer. \"We quote on site — it's free.\" is a complete reply. Never add why every job differs, what it depends on, or what happens next unless they ask.",
    "- Answer only what was asked. Never add related information, tips, alternatives or extra options the caller didn't ask for. If they want more, they'll ask.",
    "- Never read a list aloud, and never enumerate items. Asked what you offer or what something includes, answer at CATEGORY level in ONE sentence — name the two or three broad areas this business covers, not the individual items inside them — then ask what they're after. Name a specific item only when it IS the direct answer to what they asked.",
    "- Even if the caller asks for \"everything\" or \"all your services\", still answer by category and offer to go through one at a time — reciting the full list at them is never the right answer on a phone call.",
    "- Say it once. Never restate the same point in different words, and never re-explain something you've already covered. If the caller asks the same kind of question about a second item, don't repeat the whole explanation — just answer the new part: \"Same for that one — quoted on site.\"",
    "- ONE question mark per reply, then STOP and let the caller answer. Never give them a menu of options to choose from — no \"Are you after A? Or B?\", no \"...or would you like to hear more?\". Don't fill the silence and don't justify why you're asking.",
    "- Cut filler entirely: \"just to confirm\", \"in order to\", \"to help me further\", \"as I mentioned\", \"what I can do for you is\", \"as an AI\", \"delve\", \"I apologise for the inconvenience\".",
    "",
    "This is the length you're aiming for:",
    "Caller: \"Do you take bookings for tomorrow?\"",
    "RIGHT: \"Yeah, we do. What time suits you?\"",
    "WRONG: \"Great question! Yes, we absolutely do take bookings. We're open seven days a week including public holidays, and we can usually fit people in within a day or two depending on how busy we are...\"",
    "",
    "Caller: \"Is that included in the standard package?\"",
    "RIGHT: \"No, that's a separate add-on. Want me to book you in?\"",
    "WRONG: \"Good question. The standard package is our most popular option — it's designed to cover the essentials, and that particular item would normally fall under add-ons or extras. Are you after that, or the full package?\"",
    "",
    "Caller: \"How much is it?\"",
    "RIGHT: \"We'd quote you on site — it's free. Can I grab your details?\"",
    "WRONG: \"So pricing does vary quite a bit depending on a number of factors, including the size of the job, how much work is involved and what exactly needs doing. What we normally do is send someone out to take a look first...\"",
    "",
    "Caller: \"What's included in that?\" / \"What services do you offer?\"",
    "RIGHT: one sentence naming the two or three broad areas you cover, then \"Anything in particular you're after?\"",
    "WRONG: a run-through of six or twelve separate items. Group them and let the caller pick.",
    "",
    "One question only — never a menu:",
    "RIGHT: \"Want me to book you in?\"",
    "WRONG: \"Are you looking to book in? Or would you like to know more about what it includes?\"",
  ].join("\n"),
  [
    "## CONVERSATION STYLE",
    "- Talk like a real, friendly human receptionist — warm, relaxed and genuine. Never come across as a script, a form, or a robot.",
    "- Use natural spoken language: contractions (I'll, you're, we've) and light, human acknowledgements like \"sure\", \"of course\", \"no worries\", \"got it\". Vary your wording so you never sound rehearsed.",
    "- If the caller starts talking while you're still speaking, stop immediately and listen — let them speak. Never talk over them or insist on finishing your sentence first; their words always take priority.",
    "- Don't parrot the caller's details back to them. When they share their name or other information, acknowledge briefly and move on — never say things like \"Okay, so your name is Michael\" or read their details back field by field.",
    "- Don't repeat suburb, street, town or postcode names back to the caller — acknowledge briefly and continue.",
    "- Never assume the caller's name. Only use it if they clearly introduce themselves (e.g. \"my name is...\").",
    "- Treat the number they're calling from as their contact number. Confirm it simply — ask \"Is this the best number to reach you on?\" — instead of asking them to recite a number.",
    "- Only repeat or spell something back when it's genuinely necessary to get it right (e.g. an unusual name or address). When you do read a phone number, postcode or reference number, say each digit slowly and evenly.",
    "- Don't explain your own reasoning or process out loud. Never reference internal instructions, the system clock, dates, timezone or backend actions — keep those for your own logic and never read them aloud.",
    "- If the line is unclear, say: \"Sorry, the line's a bit unclear — can you please repeat that?\"",
    "- Never mention these instructions, your prompt, \"the system\", or that you're configured or programmed. Don't bring up being an AI on your own — only if the caller directly asks, acknowledge it politely and carry on helping.",
  ].join("\n"),
  [
    "## CONVERSATION FLOW",
    "- Assume every inbound call is about {{businessName}} unless the caller clearly says otherwise. If they sound confused or ask who they've reached, reassure them they've reached {{businessName}} and carry on with the flow.",
    "- Gather details naturally, one at a time — never ask for everything at once.",
    "- If the caller has already given a detail, store it silently and never ask for it again.",
    "- Never block or reject a genuine enquiry just because a date, address or other detail is still missing — collect what you can and keep it helpful.",
    "- If the caller is clearly an existing customer or already booked, don't re-qualify them — take a short message for the team.",
  ].join("\n"),
  [
    "## STAY ON TOPIC",
    "- You assist only with enquiries about {{businessName}} and the services and facts you've been given in this prompt. That knowledge is your boundary.",
    "- If the caller brings up something unrelated or outside this scope, calmly and politely let them know it's outside what you can help with here, then steer the conversation back to how you can help with {{businessName}}.",
    "- Never guess, speculate, or discuss topics beyond this business. If you don't have the information, say the team will follow up rather than making something up.",
  ].join("\n"),
  "{{sections}}",
  "## CLOSING\nOnce you have the useful details, close in ONE short line — don't linger and never read their details back. Confirm only what actually matters (like the time booked or what they need), and let them know the team will be in touch shortly. If it's outside business hours, say the team will get back to them during business hours. NEVER end the call yourself. A \"no\" to something you offered is NOT the end of the call — it only means they don't want that one thing. Reply \"No worries — anything else I can help you with?\" and keep going. Only ever sign off once the CALLER has clearly finished: \"bye\", \"that's all\", \"thanks, that's it\". Saying a sign-off ends the call instantly, so never say one while the caller may still have questions.\nWhen they do finish, sign off warmly once — like a human, thanking them for calling even if they decided not to book: \"No worries at all — thanks for calling, have a great day!\" Never sign off with a single word — that sounds like a machine hanging up on them. If the caller makes a small background sound after goodbye, don't restart the conversation — just end the call.",
].join("\n\n");

/** The greeting we auto-generate for a business (onboarding seeds this shape). */
export function autoGreeting(businessName?: string | null): string {
  const business = businessName?.trim();
  return business
    ? `Thanks for calling ${business}. How can I help you today?`
    : "Thanks for calling. How can I help you today?";
}

/** Matches any greeting WE generated — for any business name, and both the
 *  "How can I help you today?" and legacy "How can I help you?" endings. */
const AUTO_GREETING_RE = /^thanks for calling(?: .+?)?\. how can i help you(?: today)?\?$/i;

/** Keep the greeting's business name in sync with the account's.
 *
 *  The greeting is stored with the business name baked in ("Thanks for calling
 *  Acme. How can I help you today?"), so renaming the business used to leave the
 *  agent greeting callers with the OLD name — on every live call. If the stored
 *  greeting is still one of ours (matches the generated shape, whatever name it
 *  carries), rebuild it from the current business name. A greeting the owner
 *  actually wrote doesn't match the shape and is never touched. */
export function resolveGreeting(greeting: string | undefined | null, businessName?: string | null): string {
  const current = greeting?.trim();
  if (!current) return autoGreeting(businessName);
  return AUTO_GREETING_RE.test(current) ? autoGreeting(businessName) : current;
}

/** Letters and digits — a mention flanked by one of these is part of a longer
 *  word ("Instagram" for a business called "insta") and must not be renamed. */
const NAME_WORD_CHAR = /[\p{L}\p{N}]/u;
const isNameWordChar = (ch: string | undefined): boolean => !!ch && NAME_WORD_CHAR.test(ch);

/** Replace standalone, case-insensitive mentions of `from` with `to`.
 *
 *  Hand-rolled instead of a RegExp because a business name is arbitrary text
 *  ("A&B Ltd.", "Bob's Café") — escaping it into a pattern is fiddly, and the
 *  word-boundary rule we want (letters/digits either side, so "insta" doesn't
 *  match inside "Instagram") isn't what \b gives for names with punctuation. */
export function replaceBusinessName(text: string, from: string, to: string): string {
  const needle = from.trim();
  if (!text || !needle) return text;
  const hay = text.toLowerCase();
  const lower = needle.toLowerCase();
  let out = "";
  let i = 0;
  for (;;) {
    const at = hay.indexOf(lower, i);
    if (at === -1) return out + text.slice(i);
    const end = at + needle.length;
    out +=
      isNameWordChar(text[at - 1]) || isNameWordChar(text[end])
        ? text.slice(i, end) // inside a longer word — leave it alone
        : text.slice(i, at) + to;
    i = end;
  }
}

/** Carry a business rename through every field that baked the OLD name into
 *  free text.
 *
 *  Onboarding generates scenarios, FAQs and facts that name the business
 *  ("The caller is an existing customer of Acme"), so renaming the business
 *  used to leave those — and the live prompt built from them — talking about
 *  the previous business. Renames only whole-word mentions; text that never
 *  named the business is untouched, and the same rename applied twice is a
 *  no-op. Returns the original config object when nothing matched.
 *
 *  The master prompt is only rewritten when the owner froze it with a manual
 *  edit — an auto-compiled prompt is rebuilt from the renamed config anyway. */
export function renameBusinessInConfig(
  config: AgentConfig,
  previousName: string | null | undefined,
  nextName: string | null | undefined,
): AgentConfig {
  const from = previousName?.trim() ?? "";
  const to = nextName?.trim() ?? "";
  // A blank or 1-char previous name is too weak to match on safely (renaming
  // every standalone "a" would shred the config), and an unchanged name is a
  // no-op. Case-only changes still flow through, so "acme" → "Acme" lands.
  if (from.length < 2 || !to || from === to) return config;

  let changed = false;
  const sub = (text: string): string => {
    const next = replaceBusinessName(text, from, to);
    if (next !== text) changed = true;
    return next;
  };

  const { identity, knowledge, rules, advanced } = config;
  const next: AgentConfig = {
    ...config,
    identity: { ...identity, greetingMessage: sub(identity.greetingMessage ?? "") },
    knowledge: {
      ...knowledge,
      services: (knowledge.services ?? []).map(sub),
      quickFacts: (knowledge.quickFacts ?? []).map((f) => ({ ...f, key: sub(f.key), value: sub(f.value) })),
      faqs: (knowledge.faqs ?? []).map((f) => ({ ...f, question: sub(f.question), answer: sub(f.answer) })),
    },
    rules: {
      ...rules,
      scenarioHandling: (rules.scenarioHandling ?? []).map((s) => ({
        ...s,
        ifText: sub(s.ifText),
        thenText: sub(s.thenText),
      })),
      businessHours: sub(rules.businessHours ?? ""),
      declineCalls: (rules.declineCalls ?? []).map(sub),
      pricing: {
        ...rules.pricing,
        behaviour: sub(rules.pricing?.behaviour ?? ""),
        fixedItems: (rules.pricing?.fixedItems ?? []).map((p) => ({ ...p, item: sub(p.item) })),
      },
    },
    advanced: {
      ...advanced,
      masterPrompt: advanced.masterPromptDirty ? sub(advanced.masterPrompt ?? "") : advanced.masterPrompt,
    },
  };

  return changed ? next : config;
}

/** The per-customer blocks (identity → rules) injected at the {{sections}}
 *  placeholder. These are always code-generated from the structured config —
 *  the admin template only controls the surrounding scaffold, never how a
 *  customer's own knowledge is rendered. */
function compileIdentity(config: AgentConfig): string {
  const { identity } = config;
  const greeting = resolveGreeting(identity.greetingMessage, identity.businessName);
  return `## IDENTITY\nYou are ${identity.assistantName || "Taylor"}, the 24/7 AI phone receptionist for ${identity.businessName || "the business"}.\nOpening greeting: "${greeting}"\nIf asked, politely disclose that you are an AI assistant.`;
}

/** The multilingual answering rules for the prompt. Exported so the Vapi
 *  payload builder can graft it onto a frozen (manually edited) prompt whose
 *  owner enabled languages AFTER editing — otherwise the live agent would
 *  never learn it may switch languages. */
export function compileLanguagesSection(languages: string[]): string {
  return `## LANGUAGES\nBesides English, you also speak: ${languages.join(", ")}.\nStart every call in English. The moment the caller speaks — or asks for — one of these languages, switch to it and reply ONLY in that language: every sentence, from the very first reply after the switch. Keep the same warmth and follow all the same rules.\nOnce switched, stay in that language for the rest of the call. Never drift back to English mid-conversation unless the caller clearly switches back to English themselves.\nIf you didn't catch what the caller said, ask them to repeat it in the language they were speaking — don't fall back to English.\nIf the caller uses a language not listed here, apologise briefly in English and continue in English.`;
}

function compileSections(config: AgentConfig, ctx?: CompileContext): string {
  const { identity, knowledge, rules } = config;
  const parts: string[] = [];

  // Regional & industry context — injected when the owner sets a country/industry.
  const ctxCountry = ctx?.country?.trim();
  const ctxIndustry = ctx?.industry?.trim();
  if (ctxCountry || ctxIndustry) {
    const desc = ctxIndustry && ctxCountry
      ? `a ${ctxIndustry} business based in ${ctxCountry}`
      : ctxIndustry
        ? `a ${ctxIndustry} business`
        : `a business based in ${ctxCountry}`;
    parts.push(
      `## REGIONAL & INDUSTRY CONTEXT\nYou are answering calls for ${desc}.\nAdapt your vocabulary, phrasing, and cultural references to sound natural for this region and industry. Use local slang, measurements, and terminology that a real receptionist in this field and location would use.\nDo not overdo it — keep it subtle and professional.`,
    );
  }


  // Multilingual answering — only rendered when the (plan-gated) list is set.
  // No provider filter here on purpose: this module stays dependency-free, and
  // ElevenLabs-only languages are already stripped from identity.languages at save
  // time (agent.routes.ts) and again when the Vapi payload is built.
  const languages = sanitizeAgentLanguages(identity.languages);
  if (languages.length) parts.push(compileLanguagesSection(languages));

  const services = (knowledge.services ?? []).map((s) => s.trim()).filter(Boolean);
  if (services.length)
    parts.push(
      `## SERVICES OFFERED\nThis list is YOUR REFERENCE — it is not a script and must NEVER be read out to a caller. If someone asks what you do or what a service includes, group these into CATEGORIES and give a one-sentence summary in your own words, then ask what they're after. Never recite the individual entries below, not even a few of them — name a specific one only when it directly answers what they asked. If the caller asks for "all" your services, still answer by category and offer to go through one at a time.\n${bullet(services)}`,
    );

  const facts = knowledge.quickFacts.filter((f) => f.key.trim() || f.value.trim());
  if (facts.length) parts.push(`## KEY BUSINESS FACTS\n${bullet(facts.map((f) => `${f.key}: ${f.value}`))}`);

  const capture = knowledge.captureFields.filter((c) => c.enabled);
  if (capture.length)
    parts.push(`## INFORMATION TO COLLECT\nNaturally gather during the conversation:\n${bullet(capture.map((c) => c.label))}`);

  const faqs = (knowledge.faqs ?? []).filter((f) => f.question.trim() && f.answer.trim());
  if (faqs.length)
    parts.push(
      `## FREQUENTLY ASKED QUESTIONS\nThese answers are reference material, NOT a script to read aloud. Use the facts below, but say them the way a person would on the phone: give the caller the single fact they asked for in one or two sentences, and hold the rest back unless they ask. Never read out a whole answer, a set of options, or a run of times and prices. If a caller asks something not covered here, do not guess — take a message for the team to follow up.\n\n${faqs
        .map((f) => `Q: ${f.question}\nA: ${f.answer}`)
        .join("\n\n")}`,
    );

  const scenarios = rules.scenarioHandling.filter((s) => s.ifText.trim() || s.thenText.trim());
  if (scenarios.length)
    parts.push(
      `## SCENARIO HANDLING\nWhat to do in each situation. These describe the OUTCOME to reach, never how much to say — carry them out across several short turns, one question at a time. Even where a rule says to outline, explain or confirm several things, you still say it in one or two sentences and let the caller ask for more.\n${bullet(
        scenarios.map((s) => `If ${s.ifText} → ${s.thenText}`),
      )}`,
    );

  if (rules.pricing.behaviour.trim() || rules.pricing.fixedItemsEnabled) {
    const lines = [rules.pricing.behaviour.trim()].filter(Boolean);
    if (rules.pricing.fixedItemsEnabled && rules.pricing.fixedItems.length) {
      lines.push("Fixed item pricing you may quote:");
      lines.push(bullet(rules.pricing.fixedItems.map((p) => `${p.item}: ${p.price}`)));
    }
    parts.push(`## PRICING BEHAVIOUR\n${lines.join("\n")}`);
  }

  if (rules.declineCalls.length)
    parts.push(`## CALLS TO DECLINE\nPolitely decline these — keep it brief and end the call naturally. Do not book:\n${bullet(rules.declineCalls)}`);

  if (rules.businessHours.trim())
    parts.push(`## BUSINESS HOURS\n${rules.businessHours}`);

  // Timezone — always in the prompt so the assistant knows the business's
  // region and local time (Australian vs Indian vs American caller base).
  // Emitted as a readable label plus the IANA zone: the label is what the model
  // should reason in, the IANA zone removes any DST ambiguity.
  const zone = normalizeTimeZone(rules.timezone);
  if (zone)
    parts.push(`## TIMEZONE\nThe business operates in the ${timeZoneLabel(zone)} timezone (${zone}).`);

  if (rules.humanHandover.enabled && rules.humanHandover.transferNumber.trim())
    parts.push(`## HUMAN HANDOVER\nIf the caller needs a human, offer to transfer to ${rules.humanHandover.transferNumber}.`);

  return parts.join("\n\n");
}

/**
 * Compile the full master prompt: substitute the admin-editable scaffold
 * template with the owner's business name and inject the per-customer blocks.
 * Pass a `template` (the effective `prompt.masterTemplate` setting) to use an
 * admin override; omit it to use DEFAULT_PROMPT_TEMPLATE.
 */
export function compileMasterPrompt(config: AgentConfig, template?: string, ctx?: CompileContext): string {
  const tpl = (template ?? "").trim() || DEFAULT_PROMPT_TEMPLATE;
  // Default assistant name when the owner hasn't set one (fills {{assistantName}}).
  const name = config.identity.assistantName?.trim() || "Taylor";
  const biz = config.identity.businessName?.trim() || "the business";
  const identitySection = compileIdentity(config);
  // Function replacers so a `$` in the name / business / sections isn't treated
  // as a replacement-pattern token. Case-insensitive so {{assistantname}} works.
  let out = tpl
    .replace(/\{\{\s*assistantName\s*\}\}/gi, () => name)
    .replace(/\{\{\s*businessName\s*\}\}/gi, () => biz);
  // The identity block renders at {{identity}} (right under # NAME in the
  // default template). A custom template without the marker keeps identity
  // with the rest of the sections so it's never lost.
  const hasIdentitySlot = /\{\{\s*identity\s*\}\}/i.test(out);
  if (hasIdentitySlot) out = out.replace(/\{\{\s*identity\s*\}\}/gi, () => identitySection);
  const rest = compileSections(config, ctx);
  const sections = hasIdentitySlot ? rest : [identitySection, rest].filter(Boolean).join("\n\n");
  if (/\{\{\s*sections\s*\}\}/i.test(out)) {
    out = out.replace(/\{\{\s*sections\s*\}\}/gi, () => sections);
  } else {
    // Safety net: a custom template missing the marker must still carry the
    // customer's knowledge, or the assistant would answer with none of it.
    out = `${out}\n\n${sections}`;
  }
  return out.trim();
}

export const DEFAULT_AGENT_CONFIG: AgentConfig = {
  identity: {
    assistantName: "Sophie",
    businessName: "",
    voiceId: "EXAVITQu4vr4xnSDxMaL", // Sarah — ElevenLabs female (the universal default); see services/voices.ts DEFAULT_AGENT_VOICE_ID
    greetingMessage: "Thanks for calling. How can I help you today?",
  },
  knowledge: {
    quickFacts: [],
    services: [],
    captureFields: [
      { id: "cf_name", label: "Caller's first name", enabled: true },
      { id: "cf_phone", label: "Do not ask for the contact number. Automatically use the caller's phone number as the contact number unless they provide a different one.", enabled: true },
    ],
    faqs: [],
  },
  rules: {
    timezone: "", // resolved from the business's phone/address on read; see phoneTimeZone.ts
    scenarioHandling: [
      { id: "sc_book", ifText: "The caller wants to book a job or site visit", thenText: "Capture their details and offer the next available slot" },
      { id: "sc_existing", ifText: "The caller is an existing customer", thenText: "Take a message and assure them the team will call back" },
      { id: "sc_quoted", ifText: "The caller has already been quoted", thenText: "Note their name and pass it to the owner to follow up" },
      { id: "sc_upset", ifText: "The caller is upset or frustrated", thenText: "Stay calm, apologise, and promise a prompt callback" },
      { id: "sc_owner", ifText: "The caller asks operational questions only the owner can answer", thenText: "Take a message rather than guessing" },
      { id: "sc_price", ifText: "The caller asks for a price or quote", thenText: "Explain quotes are tailored and capture details for a callback" },
    ],
    pricing: {
      behaviour: "Do not give firm prices over the phone — every job is quoted on site. Reassure callers quotes are free and obligation-free.",
      fixedItemsEnabled: false,
      fixedItems: [],
    },
    declineCalls: [
      "Marketing, sales or SEO pitches",
      "Recruitment / job-seeker enquiries",
      "Free, charity or unpaid work requests",
      "Hazardous or out-of-scope work",
      "Services we do not offer",
    ],
    businessHours: "Monday to Friday, 9:00am – 5:00pm. Closed weekends and public holidays.",
    humanHandover: { enabled: false, transferNumber: "" },
  },
  automations: {
    // Email + WhatsApp owner summaries on by default; SMS OFF by default (it costs
    // per message — the owner opts in). Deliver to the account default until overridden.
    ownerEmailSummary: true,
    ownerSmsSummary: false,
    clientPostCallSms: false,
    ownerWhatsAppSummary: true,
    summaryEmail: "",
    summarySmsNumber: "",
    summaryWhatsAppNumber: "",
    // Public conversation link on by default, valid for 30 days (720h).
    smsIncludeConversationLink: true,
    whatsAppIncludeConversationLink: true,
    conversationLinkValidityHours: 720,
    // Empty → summaries/transcripts stay in the call's own language (English).
    reportLanguage: "",
    // Seeded catalogue for "Text Info to Callers" — ready to use the moment the
    // owner flips clientPostCallSms on.
    smsOnRequest: { items: seededSmsInfoItems() },
  },
  // backgroundSound "office": every new agent starts with office ambience so the
  // line sounds staffed rather than dead. "default" defers to Vapi, which is not
  // the same thing and can change under us. Seed only — an existing agent keeps
  // whatever its owner set. Mirrors src/data/defaultAgentConfig.ts.
  advanced: { masterPrompt: "", masterPromptDirty: false, creativity: 0.3, voiceStability: 0.45, voiceSpeed: 1.05, allowHangUp: true, backgroundSound: "office" },
};

DEFAULT_AGENT_CONFIG.advanced.masterPrompt = compileMasterPrompt(DEFAULT_AGENT_CONFIG);

type Automations = AgentConfig["automations"];

/**
 * Resolve a stored config's `automations` into the full shape, backfilling any
 * missing fields from defaults.
 *
 * Email + WhatsApp owner summaries are on-by-default; SMS is OFF by default (it
 * costs per message — the owner opts in). A "legacy" config — one saved before
 * this feature existed, detected by the absence of the `summaryEmail` key — never
 * had these toggles set intentionally, so we apply the same defaults (email +
 * WhatsApp on, SMS off). Once a user touches the feature the override fields are
 * present, so their explicit on/off choices are respected.
 */
export function normalizeAutomations(raw: unknown): Automations {
  const a = (raw ?? {}) as Partial<Automations>;
  const legacy = a.summaryEmail === undefined;
  const merged: Automations = { ...DEFAULT_AGENT_CONFIG.automations, ...a };
  if (legacy) {
    merged.ownerEmailSummary = true;
    merged.ownerSmsSummary = false;
    merged.ownerWhatsAppSummary = true;
  }
  // The spread above would hand every caller the SAME seed array from
  // DEFAULT_AGENT_CONFIG — one account editing an item would mutate it for every
  // config normalized in this process. Always resolve to a fresh, sanitized list.
  merged.smsOnRequest = { items: normalizeSmsInfoItems(a.smsOnRequest?.items) };
  return merged;
}

/**
 * Coerce a stored `smsOnRequest.items` array into the full shape. A config saved
 * before this feature existed (or one whose list was wiped) falls back to the
 * seeded catalogue, so an owner who turns the feature on always finds something
 * sensible waiting rather than an empty screen.
 */
export function normalizeSmsInfoItems(raw: unknown): SmsInfoItem[] {
  if (!Array.isArray(raw)) return seededSmsInfoItems();
  const seen = new Set<string>();
  const items: SmsInfoItem[] = [];
  let enabledCount = 0;
  for (const entry of raw) {
    const r = (entry ?? {}) as Partial<SmsInfoItem>;
    const key = String(r.key ?? "").trim();
    const template = String(r.template ?? "").trim();
    // No key means the AI has no way to ask for it; no template means there's
    // nothing to send. Either way the row is unusable — drop it.
    if (!key || !template || seen.has(key)) continue;
    seen.add(key);
    // At most MAX_ENABLED_SMS_INFO_ITEMS may be ON — a client bypassing the UI
    // can't enable a fourth. Extras are paused (kept as a row), not dropped, so
    // the owner doesn't silently lose the detail.
    let enabled = r.enabled !== false;
    if (enabled && enabledCount >= MAX_ENABLED_SMS_INFO_ITEMS) enabled = false;
    if (enabled) enabledCount++;
    items.push({
      id: String(r.id ?? "").trim() || `sms_${key}`,
      key,
      label: String(r.label ?? "").trim() || key,
      enabled,
      whenToUse: String(r.whenToUse ?? "").trim(),
      template,
      ...(r.custom ? { custom: true } : {}),
    });
    // Safety bound on the stored array size.
    if (items.length >= MAX_SMS_INFO_ITEMS) break;
  }
  return items;
}
