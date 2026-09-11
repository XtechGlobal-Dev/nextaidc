// Sync the admin "Default Agent Model" catalogue from Vapi.
//
// Vapi exposes NO public per-model cost/latency API. The numbers shown in Vapi's
// dashboard model picker come from a cost estimator bundled in the dashboard's
// own frontend. This script reproduces exactly what the dashboard shows by:
//   1. pulling the provider + model list from Vapi's live OpenAPI schema
//      (https://api.vapi.ai/api-json), then
//   2. downloading the dashboard bundle, locating its cost-estimator chunk, and
//      running Vapi's real estimator to get each model's cost/min + latency
//      (the dropdown badge uses tokenLength 0 -> 500 tokens, matched here).
// It then rewrites the AGENT_LLM_OPTIONS array in
//   server/src/lib/agentConfig.ts
// between its `= [` and `];` markers, leaving the rest of the file untouched.
//
// Run:  node scripts/syncVapiModels.mjs
//
// Filters (kept intentionally, mirror the hand-curated catalogue):
//   - only providers with a fixed model enum (free-text providers like
//     openrouter/together-ai/custom-llm are skipped — no safe dropdown),
//   - OpenAI Azure region-pinned (":region") and realtime variants dropped,
//   - Google realtime variants dropped.

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OPENAPI = "https://api.vapi.ai/api-json";
const DASH = "https://dashboard.vapi.ai";

// Provider display labels + the OpenAPI schema that holds each provider's enum.
const PROVIDERS = [
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

async function getText(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`GET ${url} -> ${res.status}`);
  return res.text();
}
async function getJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`GET ${url} -> ${res.status}`);
  return res.json();
}

/** Model id enum for a provider from the OpenAPI schema, with the noise filters. */
function modelsFor(schemas, provider) {
  const prop = schemas[provider.schema]?.properties?.model;
  let m = [];
  if (prop?.enum) m = prop.enum;
  else if (prop?.anyOf) for (const a of prop.anyOf) if (a.enum) m = m.concat(a.enum);
  if (provider.id === "openai") m = m.filter((x) => !x.includes(":") && !x.includes("realtime"));
  if (provider.id === "google") m = m.filter((x) => !x.includes("realtime"));
  return m;
}

/** Parse a Vapi provider enum `NAME=(yl=>(yl.KEY="val",...))(NAME||{})` into an object. */
function parseEnum(main, localName) {
  const i = main.indexOf(localName + "=(");
  if (i < 0) return null;
  const slice = main.slice(i, i + 2000);
  const out = {};
  const re = /\w+\.([A-Z0-9_]+)="([^"]*)"/g;
  let m;
  while ((m = re.exec(slice))) out[m[1]] = m[2];
  return Object.keys(out).length ? out : null;
}

/** Build the Vapi cost estimator object `z` by evaluating its dashboard chunk. */
async function loadEstimator() {
  // 1) main bundle
  const html = await getText(`${DASH}/`);
  const mainRef = html.match(/\/js\/index-[A-Za-z0-9]+\.js/)?.[0];
  if (!mainRef) throw new Error("could not find main JS bundle in dashboard HTML");
  const main = await getText(`${DASH}${mainRef}`);

  // 2) find the estimator chunk among referenced chunks (signature: z={STT... LLM...)
  const chunkNames = [...new Set((main.match(/js\/[A-Za-z0-9_.-]+\.js/g) || []))];
  let estimator = null;
  for (const name of chunkNames) {
    if (!/estimator|index-/.test(name)) continue; // cheap prefilter
    let src;
    try {
      src = await getText(`${DASH}/${name}`);
    } catch {
      continue;
    }
    if (src.includes("STT:{") && src.includes("LLM:{") && /export\{[^}]*\bas g\}/.test(src)) {
      estimator = src;
      break;
    }
  }
  if (!estimator) throw new Error("could not locate Vapi cost-estimator chunk");

  // 3) resolve the chunk's imports from the main bundle, then evaluate it
  const enums = {
    LLM_PROVIDERS: parseEnum(main, "LLM_PROVIDERS"),
    TRANSCRIBE_PROVIDERS: parseEnum(main, "TRANSCRIBE_PROVIDERS"),
    VOICE_PROVIDERS: parseEnum(main, "VOICE_PROVIDERS"),
  };
  // export-name -> local-name (from `LOCAL as EXPORT` pairs anywhere in the bundle)
  const expToLocal = {};
  for (const m of main.matchAll(/([A-Za-z_$][\w$]*)\s+as\s+([A-Za-z_$][\w$]*)/g)) {
    expToLocal[m[2]] = m[1];
  }
  const enumLocalToKey = {
    [expToLocal.ch]: "LLM_PROVIDERS",
    [expToLocal.cl]: "TRANSCRIBE_PROVIDERS",
    [expToLocal.cn]: "VOICE_PROVIDERS",
  };

  const imp = estimator.match(/import\{([^}]*)\}from"\.\/index-[A-Za-z0-9]+\.js"/);
  if (!imp) throw new Error("estimator import line not found");
  let decl = "";
  for (const pair of imp[1].split(",")) {
    const [exp, alias] = pair.trim().split(/\s+as\s+/);
    const local = expToLocal[exp];
    const enumKey = enumLocalToKey[local];
    if (enumKey && enums[enumKey]) {
      decl += `const ${alias}=${JSON.stringify(enums[enumKey])};`;
      continue;
    }
    // string constant: LOCAL="..."
    const sm = local && main.match(new RegExp(local.replace(/[$]/g, "\\$") + '="([^"]*)"'));
    if (sm) decl += `const ${alias}=${JSON.stringify(sm[1])};`;
    else decl += `const ${alias}=(x)=>x;`; // helpers/labels we don't need
  }

  let body = estimator
    .replace(/^!function\(\)\{try\{[\s\S]*?\}catch\(e\)\{\}\}\(\);/, "")
    .replace(/import\{[^}]*\}from"\.\/index-[A-Za-z0-9]+\.js";/, "");
  body = body.slice(0, body.lastIndexOf("export{"));

  // eslint-disable-next-line no-new-func
  return new Function(decl + body + "; return z;")();
}

/** Cost/min + latency for a model, exactly as Vapi's dropdown badge computes it. */
function estimate(z, provider, model) {
  const entry = z.LLM[`${provider}-${model}`] || z.LLM[provider];
  if (!entry) return { costPerMin: null, latencyMs: null };
  const c = typeof entry === "function" ? entry({ model }) : entry;
  if (!c || typeof c.cost === "undefined") return { costPerMin: null, latencyMs: null };
  const cost = typeof c.cost === "function" ? c.cost(500) : c.cost; // tokenLength 0 -> 500
  return { costPerMin: Math.round(cost * 100) / 100, latencyMs: c.latency ?? null };
}

async function main() {
  console.log("Fetching Vapi OpenAPI schema…");
  const schemas = (await getJson(OPENAPI)).components.schemas;
  console.log("Loading Vapi cost estimator from dashboard bundle…");
  const z = await loadEstimator();

  const lines = [];
  let count = 0;
  for (const p of PROVIDERS) {
    lines.push(`  // ${p.label}`);
    for (const model of modelsFor(schemas, p)) {
      const { costPerMin, latencyMs } = estimate(z, p.id, model);
      lines.push(
        `  { provider: ${JSON.stringify(p.id)}, model: ${JSON.stringify(model)}, ` +
          `label: ${JSON.stringify(model)}, providerLabel: ${JSON.stringify(p.label)}, ` +
          `costPerMin: ${costPerMin === null ? "null" : costPerMin}, ` +
          `latencyMs: ${latencyMs === null ? "null" : latencyMs} },`,
      );
      count++;
    }
  }

  const file = join(ROOT, "server/src/lib/agentConfig.ts");
  const src = readFileSync(file, "utf8");
  const nl = src.includes("\r\n") ? "\r\n" : "\n";
  const startMarker = "export const AGENT_LLM_OPTIONS: AgentLlmOption[] = [";
  const si = src.indexOf(startMarker);
  const bodyStart = si + startMarker.length;
  const endIdx = src.indexOf(`${nl}];`, bodyStart);
  if (si < 0 || endIdx < 0) throw new Error("AGENT_LLM_OPTIONS markers not found in agentConfig.ts");
  const next =
    src.slice(0, bodyStart) + nl + lines.join(nl).replace(/\n/g, nl) + nl + src.slice(endIdx + nl.length);
  writeFileSync(file, next);
  console.log(`✅ Synced ${count} models into agentConfig.ts`);
}

main().catch((e) => {
  console.error("Sync failed:", e.message);
  process.exit(1);
});
