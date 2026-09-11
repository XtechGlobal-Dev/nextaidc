import { createHash } from "node:crypto";
import { getEffective, integrationsStatus } from "./settings.js";
import { buildChatBody, openAiTokenUnits } from "../lib/openai.js";
import { traceFetch } from "./apiTrace.js";
import { prisma } from "../prisma.js";

/* Persisted summary cache (prompt_cache table). The Prisma client is regenerated
 * at deploy (render:build runs `prisma generate`), so `prisma.promptCache` exists
 * at runtime; the cast lets this typecheck locally before the client is
 * regenerated. All access is best-effort — a DB hiccup must never break prompt
 * building, so failures fall through to the (in-memory cache →) LLM path. */
const promptCacheStore = (
  prisma as unknown as {
    promptCache: {
      findUnique(args: { where: { hash: string } }): Promise<{ summary: string } | null>;
      upsert(args: {
        where: { hash: string };
        create: { hash: string; summary: string };
        update: { summary: string };
      }): Promise<unknown>;
    };
  }
).promptCache;

async function dbCacheGet(hash: string): Promise<string | null> {
  try {
    return (await promptCacheStore.findUnique({ where: { hash } }))?.summary ?? null;
  } catch {
    return null;
  }
}

function dbCacheSet(hash: string, summary: string): void {
  // Fire-and-forget: persisting the summary must not add latency to (or fail) the
  // response that just computed it. The in-memory cache already covers this
  // instance; the DB write is what survives a cold start / helps other instances.
  void promptCacheStore
    .upsert({ where: { hash }, create: { hash, summary }, update: { summary } })
    .catch(() => {});
}

/* ------------------------------------------------------------------ *
 *  LLM compression of a receptionist system prompt before it's pushed
 *  to the live agent (Vapi / web test calls). Invisible to customers —
 *  their AI Brain keeps showing the full prompt; only the wire copy is
 *  compressed to save tokens on every call.
 *
 *  Best-effort by design: no OpenAI key, an API error, a timeout, or a
 *  suspicious result (empty / longer / gutted) all fall back to the
 *  original prompt, so a save or provision is NEVER blocked.
 * ------------------------------------------------------------------ */

const SUMMARIZER_INSTRUCTIONS = [
  "You compress a phone-receptionist system prompt to the minimum length that keeps EXACTLY the same behaviour.",
  "Rules:",
  "- Keep every heading (lines starting with # or ##) and the overall section order.",
  '- Keep VERBATIM, word-for-word: the opening greeting in quotes, every FAQ question and answer, the services list, the "information to collect" items, every scenario (If → Then) rule, business facts (phone, email, address, website), the timezone, and any prices.',
  "- Keep the LANGUAGES section (which languages it speaks and the language-switching rules) — you may tighten its wording but every rule in it must survive.",
  '- You MAY drop the entire "HOW MUCH TO SAY" section, examples and all. It is re-attached verbatim after you run (see buildVapiSystemPrompt), so compressing it wastes effort and risks weakening it. Leave the rest of the prompt intact around it.',
  '- Keep the one-line guidance that precedes the services list, the FAQ list and the scenario rules — the sentences saying they are reference material and must not be read aloud. Without them the agent recites the lists at the caller.',
  '- Keep, word for word, the closing rule that the agent must NEVER end the call itself and that a "no" to an offer is not the end of the call. Saying a sign-off phrase hangs up instantly, so losing this rule drops live callers mid-conversation.',
  "- Compress only the surrounding instructions and prose: merge overlapping rules, drop filler, use tight wording.",
  "- Never add new rules, never change the meaning of a rule, never invent facts.",
  "- Output ONLY the compressed prompt text — no commentary, no markdown fences.",
].join("\n");

/** Below this size a prompt isn't worth an LLM round-trip — pushed as-is. */
const MIN_CHARS_TO_SUMMARIZE = 1800;

/** A result gutted below this fraction of the original almost certainly lost
 *  content (FAQs/services) — treat it as a bad summary and keep the original. */
const MIN_KEEP_RATIO = 0.25;

/** Same prompt → same summary, without paying for the LLM again (saves/resyncs
 *  repeat identical prompts often). Small bounded in-memory cache. */
const cache = new Map<string, string>();
const CACHE_MAX = 200;

const hashOf = (s: string) => createHash("sha1").update(s).digest("hex");

/** Strip a ```fence``` wrapper if the model added one despite instructions. */
function unfence(s: string): string {
  const m = s.match(/^```[a-z]*\n([\s\S]*?)\n```$/);
  return m ? m[1].trim() : s;
}

/**
 * Compress `prompt` for the live agent. Returns the original prompt whenever
 * summarizing isn't possible or the result looks unsafe — callers can always
 * trust the return value to be a usable system prompt.
 */
export async function summarizePromptForVapi(prompt: string): Promise<string> {
  const original = (prompt ?? "").trim();
  if (!original || original.length < MIN_CHARS_TO_SUMMARIZE) return original;
  if (!integrationsStatus().openai) return original;

  const key = hashOf(original);
  const hit = cache.get(key);
  if (hit) return hit;

  // Persisted cache — survives restarts / cold starts, so an unchanged prompt
  // skips the slow LLM summarization even on a freshly-woken instance (the main
  // cause of the 15-20s test-call connect on staging).
  const dbHit = await dbCacheGet(key);
  if (dbHit) {
    cache.set(key, dbHit);
    return dbHit;
  }

  try {
    const apiKey = getEffective("openai.apiKey");
    const model = getEffective("openai.model") || "gpt-5";
    const res = await traceFetch("openai", "https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify(
        buildChatBody({
          model,
          messages: [
            { role: "system", content: SUMMARIZER_INSTRUCTIONS },
            { role: "user", content: original },
          ],
          maxTokens: 4000,
          temperature: 0.2,
          reasoningEffort: "minimal",
        }),
      ),
      signal: AbortSignal.timeout(25_000),
    }, { unitsFromResponse: openAiTokenUnits });
    if (!res.ok) throw new Error(`OpenAI error ${res.status}`);

    const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
    const out = unfence(data.choices?.[0]?.message?.content?.trim() || "");

    // Sanity gate: non-empty, actually shorter, and not gutted.
    if (!out || out.length >= original.length || out.length < original.length * MIN_KEEP_RATIO) {
      return original;
    }

    if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value as string);
    cache.set(key, out);
    dbCacheSet(key, out); // persist so cold starts / other instances reuse it
    console.log(
      `📝 Prompt summarized for live agent: ${original.length} → ${out.length} chars`,
    );
    return out;
  } catch (e) {
    console.warn(
      "Prompt summarize failed — pushing full prompt:",
      e instanceof Error ? e.message : e,
    );
    return original;
  }
}
