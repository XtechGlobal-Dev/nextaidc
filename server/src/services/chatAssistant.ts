import { getEffective, integrationsStatus } from "./settings.js";
import { buildChatBody, openAiTokenUnits } from "../lib/openai.js";
import { traceFetch } from "./apiTrace.js";
import { brandDisplayName } from "../lib/brandUrls.js";

/* ------------------------------------------------------------------ *
 *  Support-chat assistant. Uses OpenAI when an admin has configured a
 *  key (Admin → Settings, DB → env fallback); otherwise returns a
 *  canned reply so the widget always responds.
 * ------------------------------------------------------------------ */

export const CANNED_REPLIES = [
  "Great question! You can configure your AI receptionist's greeting and behaviour from the AI Brain tab in your dashboard.",
  "To connect a phone number, head to your Profile settings and activate your receptionist number.",
  "You can review every call your assistant handles under the Calls section, including transcripts and outcomes.",
  "Need to integrate your CRM? Open the CRM tab to connect a provider or add a custom webhook.",
  "I'm here to help! If you'd like to speak with a human, let me know and I'll flag this conversation for our team.",
];

/** Built per-request so the assistant always knows the current date and never
 *  falls back to citing its training cutoff. */
function buildSystemPrompt(): string {
  const today = new Date().toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
  });
  const appName = brandDisplayName();
  return (
    // Named for the tenant the request came through, so a brand's customer is
    // never told they are talking to the platform.
    `You are the ${appName} support assistant. Today's date is ${today}. ` +
    `${appName} is a 24/7 AI voice receptionist for small businesses. ` +
    "Help users set up and use the product: the AI Brain (agent config), call logs, CRM lead delivery, billing, and their receptionist phone number. " +
    "Be concise, friendly, and practical. " +
    "Reply in plain conversational text only — NO markdown: no **bold**, no headings, no `code`, no markdown list syntax. " +
    "When listing features or steps, use short lines separated by line breaks (e.g. '- AI Brain: configure your agent'), never asterisks or numbered markdown. " +
    "Never mention your training data, a knowledge cutoff, or any year your knowledge ends — for product help you are always current. " +
    "You don't have access to a customer's private business details or any external/real-time information. " +
    "If you're asked about something you can't know (e.g. a specific company's services), do NOT guess or cite dates — briefly say you don't have that detail and offer to flag it for the team. " +
    "If a request needs a human, offer to flag the conversation for the team. " +
    "Handoff protocol: before handing off, collect the user's name, business, contact email, and topic. " +
    "Then, in the single message where you confirm the handoff was sent, append a final line of exactly this form: " +
    'HANDOFF: {"name":"...","business":"...","email":"...","topic":"...","summary":"one-line summary of what they need"} ' +
    "That line is machine-read to actually notify the team and is stripped before the user sees your message — never mention it, never emit it without the user's details, and emit it at most once per handoff."
  );
}

export interface HandoffRequest {
  name?: string;
  business?: string;
  email?: string;
  topic?: string;
  summary?: string;
}

export interface SupportReply {
  reply: string;
  /** Set when the assistant signalled a handoff — the caller must notify the team. */
  handoff: HandoffRequest | null;
}

/** Pull the machine-read HANDOFF line (if any) out of a raw LLM reply. The
 *  marker always triggers a handoff, even if its JSON is mangled — the emailed
 *  transcript carries the details either way. */
function extractHandoff(raw: string): SupportReply {
  const m = raw.match(/^\s*HANDOFF:\s*(\{.*\})?\s*$/m);
  if (!m) return { reply: raw.trim(), handoff: null };
  const reply = raw.replace(m[0], "").trim();
  let handoff: HandoffRequest = {};
  try {
    const parsed = JSON.parse(m[1] || "{}") as Record<string, unknown>;
    for (const key of ["name", "business", "email", "topic", "summary"] as const) {
      if (typeof parsed[key] === "string") handoff[key] = (parsed[key] as string).trim();
    }
  } catch {
    /* mangled JSON — hand off with the transcript only */
  }
  // Guard against a marker-only reply leaving the user with an empty bubble.
  return {
    reply: reply || "Done — I've flagged this conversation for our support team. They'll email you shortly.",
    handoff,
  };
}

interface HistoryMessage {
  role: string; // "user" | "assistant" | "human"
  content: string;
}

/** Generate a support reply — OpenAI if configured, else a canned fallback. */
export async function generateSupportReply(
  history: HistoryMessage[],
  userMessage: string,
  fallbackIndex: number,
): Promise<SupportReply> {
  const canned: SupportReply = {
    reply: CANNED_REPLIES[fallbackIndex % CANNED_REPLIES.length],
    handoff: null,
  };
  if (!integrationsStatus().openai) return canned;

  try {
    const apiKey = getEffective("openai.apiKey");
    const model = getEffective("openai.model") || "gpt-5";
    const messages = [
      { role: "system", content: buildSystemPrompt() },
      ...history.map((m) => ({
        role: m.role === "user" ? "user" : "assistant",
        content: m.content,
      })),
      { role: "user", content: userMessage },
    ];

    const res = await traceFetch("openai", "https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify(
        // 450 tokens leaves room for the handoff summary + machine-read HANDOFF line.
        buildChatBody({ model, messages, maxTokens: 450, temperature: 0.4, reasoningEffort: "minimal" }),
      ),
    }, { unitsFromResponse: openAiTokenUnits });
    if (!res.ok) throw new Error(`OpenAI error ${res.status}`);

    const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
    const raw = data.choices?.[0]?.message?.content?.trim();
    return raw ? extractHandoff(raw) : canned;
  } catch {
    // Never break the chat on an LLM failure — fall back to a canned reply.
    return canned;
  }
}
