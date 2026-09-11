import { allTenants, tenantForUser } from "./tenantDb.js";
import { getEffective, integrationsStatus, getVapiPromptTemplate } from "./settings.js";
import { compileMasterPrompt, DEFAULT_AGENT_CONFIG, type AgentConfig } from "../lib/agentConfig.js";
import { buildChatBody, openAiTokenUnits } from "../lib/openai.js";
import { traceFetch } from "./apiTrace.js";

/* ------------------------------------------------------------------ *
 *  Inbound WhatsApp → AI reply. The platform has a single WhatsApp
 *  number, so every inbound message is answered by one agent's "brain"
 *  (the same compiled config that drives the voice receptionist),
 *  adapted for short text replies. Uses the configured OpenAI key; if
 *  none is set we fall back to a polite holding reply so the sender
 *  always gets something back.
 * ------------------------------------------------------------------ */

interface ResolvedAgent {
  userId: string;
  config: AgentConfig;
}

/** Which agent answers inbound WhatsApp: an explicit setting, else the most
 *  recently updated approved agent (falling back to any agent). null if none. */
export async function resolveWhatsAppAgent(): Promise<ResolvedAgent | null> {
  const pinnedUserId = getEffective("whatsapp.agentUserId").trim();
  if (pinnedUserId) {
    const c = await tenantForUser(pinnedUserId)
      .then((db) => db.conversion.findUnique({ where: { userId: pinnedUserId } }))
      .catch(() => null);
    if (c) return { userId: c.userId, config: c.agentConfig as unknown as AgentConfig };
  }

  // Nothing pinned: the most recently updated approved agent in any brand's
  // database, else the most recently updated agent at all.
  let best: { userId: string; agentConfig: unknown; updatedAt: Date; approved: boolean } | null = null;
  for (const { db } of await allTenants()) {
    const c =
      (await db.conversion.findFirst({ where: { status: "approved" }, orderBy: { updatedAt: "desc" } })) ??
      (await db.conversion.findFirst({ orderBy: { updatedAt: "desc" } }));
    if (!c) continue;
    const approved = c.status === "approved";
    if (!best || (approved && !best.approved) || (approved === best.approved && c.updatedAt > best.updatedAt)) {
      best = { userId: c.userId, agentConfig: c.agentConfig, updatedAt: c.updatedAt, approved };
    }
  }
  if (!best) return null;
  return { userId: best.userId, config: best.agentConfig as unknown as AgentConfig };
}

export interface ChatTurn {
  role: "user" | "assistant";
  content: string;
}

const CHANNEL_GUIDANCE =
  "\n\n## CHANNEL\nYou are replying over WhatsApp text chat, not voice. Keep replies short and friendly " +
  "(1–3 sentences). Plain text only — no markdown or asterisks. Ask one question at a time when collecting details.";

/** The system prompt for an agent — its customised master prompt if set, else
 *  freshly compiled from the structured config — plus WhatsApp channel guidance. */
function systemPromptFor(config: AgentConfig): string {
  const base =
    config.advanced?.masterPrompt?.trim() ||
    compileMasterPrompt(config ?? DEFAULT_AGENT_CONFIG, getVapiPromptTemplate());
  return base + CHANNEL_GUIDANCE;
}

const HOLDING_REPLY =
  "Thanks for your message! Our team has received it and will get back to you shortly.";

/** Generate a reply from the agent brain. OpenAI when configured, else a holding reply. */
export async function generateAgentReply(
  config: AgentConfig,
  history: ChatTurn[],
  userMessage: string,
): Promise<string> {
  if (!integrationsStatus().openai) return HOLDING_REPLY;

  try {
    const apiKey = getEffective("openai.apiKey");
    const model = getEffective("openai.model") || "gpt-5";
    const messages = [
      { role: "system", content: systemPromptFor(config) },
      ...history.map((m) => ({ role: m.role, content: m.content })),
      { role: "user", content: userMessage },
    ];

    const res = await traceFetch("openai", "https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify(
        buildChatBody({ model, messages, maxTokens: 300, temperature: 0.4, reasoningEffort: "minimal" }),
      ),
    }, { unitsFromResponse: openAiTokenUnits });
    if (!res.ok) throw new Error(`OpenAI error ${res.status}`);

    const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
    return data.choices?.[0]?.message?.content?.trim() || HOLDING_REPLY;
  } catch {
    return HOLDING_REPLY;
  }
}
