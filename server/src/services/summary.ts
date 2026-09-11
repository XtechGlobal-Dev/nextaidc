import { getEffective, integrationsStatus } from "./settings.js";
import { buildChatBody, openAiTokenUnits } from "../lib/openai.js";
import { traceFetch } from "./apiTrace.js";

/* ------------------------------------------------------------------ *
 *  Call-transcript summariser + translator. Uses OpenAI when an admin
 *  has configured a key (Admin → Settings, DB → env fallback). Every
 *  function is best-effort and never throws — callers fall back to the
 *  original English text on any failure.
 * ------------------------------------------------------------------ */

interface Turn {
  role: string; // "agent" | anything else (treated as caller)
  text: string;
}

/** A report language of ""/"english" means keep the original — no translation. */
export function needsTranslation(language: string | null | undefined): boolean {
  const l = (language ?? "").trim().toLowerCase();
  return l.length > 0 && l !== "english";
}

/** Normalise a stored transcript into `{ role, text, at? }` turns. Vapi phone
 *  calls store the transcript as a "Role: text" STRING; the web widget stores an
 *  array. This unifies both so translation/rendering works the same everywhere. */
export function normalizeTranscript(raw: unknown): { role: string; text: string; at?: number }[] {
  if (typeof raw === "string") {
    return raw
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean)
      .map((line) => {
        const m = line.match(
          /^(agent|assistant|ai|bot|user|caller|customer|human)\s*[:\-]\s*(.*)$/i,
        );
        if (m) return { role: /^(agent|assistant|ai|bot)$/i.test(m[1]) ? "agent" : "caller", text: m[2] };
        return { role: "", text: line };
      })
      .filter((t) => t.text);
  }
  if (Array.isArray(raw)) {
    return (raw as any[])
      .map((t) => ({
        role: String(t?.role ?? t?.speaker ?? ""),
        text: String(t?.text ?? t?.message ?? t?.content ?? ""),
        at: typeof t?.at === "number" ? t.at : undefined,
      }))
      .filter((t) => t.text);
  }
  return [];
}

/** Low-level OpenAI chat call. Returns the message content, or "" on any failure. */
async function chat(
  messages: { role: string; content: string }[],
  maxTokens: number,
): Promise<string> {
  if (!integrationsStatus().openai) return "";
  try {
    const apiKey = getEffective("openai.apiKey");
    const model = getEffective("openai.model") || "gpt-5";
    const res = await traceFetch("openai", "https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify(
        buildChatBody({ model, messages, maxTokens, temperature: 0.2, reasoningEffort: "minimal" }),
      ),
    }, { unitsFromResponse: openAiTokenUnits });
    if (!res.ok) throw new Error(`OpenAI error ${res.status}`);
    const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
    return data.choices?.[0]?.message?.content?.trim() || "";
  } catch {
    return "";
  }
}

/** Summarise a call transcript. When `language` is a non-English report language,
 *  the summary is written in that language. Returns "" if OpenAI isn't configured. */
export async function summarizeCallTranscript(turns: Turn[], language?: string): Promise<string> {
  if (!turns.length) return "";
  const langLine = needsTranslation(language)
    ? ` Write the summary in ${language!.trim()}.`
    : "";
  const system =
    "You summarize a phone call for a busy business owner. In 1-2 short sentences, " +
    "capture what the caller wanted and any action needed. Be specific and concise. No preamble." +
    langLine;
  const transcript = turns
    .map((t) => `${t.role === "agent" ? "Agent" : "Caller"}: ${t.text}`)
    .join("\n");
  return chat(
    [
      { role: "system", content: system },
      { role: "user", content: `Summarize this call:\n\n${transcript}` },
    ],
    160,
  );
}

export interface CallIntentRead {
  /** "support" | "spam" | "none" — never "booking" or "lead", by design. */
  category: string;
  /** True when the caller gave, or the AI successfully took, a way to reach
   *  them back. Feeds the deterministic `lead` rule for calls that carry no
   *  Vapi structuredData. */
  contactCaptured: boolean;
}

/** Read a call for the inbox badge: what kind of call it was, and whether we
 *  ended up with a way to contact the caller.
 *
 *  Only used where Vapi didn't extract this for us — WEB/TEST calls carry no
 *  structuredData at all, so without this a test call could never be a lead no
 *  matter how much the AI collected. One request answers both questions.
 *
 *  Returns nulls when OpenAI isn't configured or the reply doesn't parse; the
 *  caller then falls back to the keyword heuristic and the structuredData rule. */
export async function classifyCallIntent(turns: Turn[]): Promise<CallIntentRead> {
  const empty: CallIntentRead = { category: "", contactCaptured: false };
  if (!turns.length) return empty;
  const transcript = turns
    .map((t) => `${t.role === "agent" ? "Agent" : "Caller"}: ${t.text}`)
    .join("\n");
  const raw = await chat(
    [
      {
        role: "system",
        content:
          "You read a phone call to a small business and return ONLY a JSON object, no prose:\n" +
          '{"category": "...", "contactCaptured": true|false}\n\n' +
          "category is EXACTLY one of:\n" +
          "  support — an EXISTING customer with a problem, complaint, or an order/job to chase up\n" +
          "  spam — wrong number, robocall, telemarketing, or nothing meaningful was said\n" +
          "  none — anything else, INCLUDING a caller asking to make a booking, a price " +
          "enquiry, or a new customer asking about services\n" +
          "Answer 'none' rather than guessing.\n\n" +
          "contactCaptured is true if, by the end of the call, the business has a way to reach " +
          "this caller back: the caller gave their name, email or a phone number, OR the agent " +
          "asked and the caller confirmed the number they are calling from is fine. " +
          "It is false if the caller refused, or was never asked, or gave nothing.",
      },
      { role: "user", content: transcript },
    ],
    60,
  );
  if (!raw) return empty;
  try {
    const json = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
    const parsed = JSON.parse(json) as { category?: unknown; contactCaptured?: unknown };
    return {
      category:
        typeof parsed.category === "string"
          ? parsed.category.trim().toLowerCase().replace(/[^a-z_]/g, "")
          : "",
      contactCaptured: parsed.contactCaptured === true,
    };
  } catch {
    return empty;
  }
}

/** Translate a short piece of text (e.g. an existing summary) into `language`.
 *  Returns "" on failure so the caller keeps the original. */
export async function translateText(text: string, language: string): Promise<string> {
  const source = text.trim();
  if (!source || !needsTranslation(language)) return "";
  return chat(
    [
      {
        role: "system",
        content:
          `You are a professional translator. Translate the user's text into ${language.trim()}. ` +
          "Preserve meaning and tone. Output ONLY the translation, with no quotes or preamble.",
      },
      { role: "user", content: source },
    ],
    Math.min(1200, Math.ceil(source.length / 2) + 200),
  );
}

/** Translate every turn of a transcript into `language`, preserving roles and order.
 *  Returns the translated turns, or `null` if translation isn't possible/failed so
 *  the caller keeps the original transcript. */
export async function translateTranscript(
  turns: Turn[],
  language: string,
): Promise<Turn[] | null> {
  if (!turns.length || !needsTranslation(language)) return null;
  // Send the turn texts as a JSON array and ask for a same-length JSON array back,
  // so we can map each translation straight back onto its role.
  const texts = turns.map((t) => t.text ?? "");
  const raw = await chat(
    [
      {
        role: "system",
        content:
          `You are a professional translator. Translate each string in the JSON array into ${language.trim()}. ` +
          "Return ONLY a JSON array of the translated strings, same length and order, no extra keys or text.",
      },
      { role: "user", content: JSON.stringify(texts) },
    ],
    Math.min(4000, texts.join(" ").length + 400),
  );
  if (!raw) return null;
  try {
    // Tolerate a fenced code block around the JSON.
    const json = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
    const arr = JSON.parse(json) as unknown;
    if (!Array.isArray(arr) || arr.length !== turns.length) return null;
    return turns.map((t, i) => ({ role: t.role, text: String(arr[i] ?? t.text) }));
  } catch {
    return null;
  }
}
