import express from "express";
import crypto from "node:crypto";
import { getEffective } from "../services/settings.js";
import { sendWhatsApp } from "../services/whatsapp.js";
import { getPlanFeatures } from "../services/trial.js";
import {
  resolveWhatsAppAgent,
  generateAgentReply,
  type ChatTurn,
} from "../services/whatsappAgent.js";

/* ------------------------------------------------------------------ *
 *  Meta WhatsApp Cloud API webhook.
 *    GET  /api/whatsapp/webhook  — Meta's subscribe handshake (echo challenge)
 *    POST /api/whatsapp/webhook  — inbound messages → AI reply
 *
 *  Mounted with express.raw so we can verify Meta's X-Hub-Signature-256
 *  against the exact bytes (the app-level JSON parser skips this path).
 *
 *  Conversation memory is in-process (resets on restart) — a deliberate v1
 *  trade-off to avoid a new table on the shared DB. See server/MIGRATIONS.md.
 * ------------------------------------------------------------------ */

const router = express.Router();

// sender wa-id → recent turns (oldest first), capped.
const HISTORY_LIMIT = 12;
const MAX_THREADS = 500;
const threads = new Map<string, ChatTurn[]>();

function remember(sender: string, turn: ChatTurn): ChatTurn[] {
  const existing = threads.get(sender) ?? [];
  const next = [...existing, turn].slice(-HISTORY_LIMIT);
  threads.delete(sender); // re-insert to mark as most-recently-used
  threads.set(sender, next);
  if (threads.size > MAX_THREADS) {
    const oldest = threads.keys().next().value;
    if (oldest) threads.delete(oldest);
  }
  return next;
}

/** Constant-time check of Meta's HMAC-SHA256 body signature, when an app secret
 *  is configured. Returns true (skip) when no secret is set. */
function verifySignature(raw: Buffer, header: string | undefined): boolean {
  const secret = getEffective("whatsapp.appSecret").trim();
  if (!secret) return true; // not configured — rely on the verify-token handshake
  if (!header?.startsWith("sha256=")) return false;
  const expected = "sha256=" + crypto.createHmac("sha256", secret).update(raw).digest("hex");
  const a = Buffer.from(header);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// --- Verification handshake (no body) ---
router.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];
  const expected = getEffective("whatsapp.verifyToken").trim();

  if (mode === "subscribe" && expected && token === expected) {
    res.status(200).send(String(challenge ?? ""));
    return;
  }
  res.sendStatus(403);
});

interface WhatsAppText {
  from: string;
  type: string;
  text?: { body?: string };
}

/** Pull plain text messages out of a Meta webhook payload. */
function extractTextMessages(payload: unknown): { from: string; body: string }[] {
  const out: { from: string; body: string }[] = [];
  const entries = (payload as { entry?: unknown[] })?.entry ?? [];
  for (const entry of entries) {
    const changes = (entry as { changes?: unknown[] })?.changes ?? [];
    for (const change of changes) {
      const messages = (change as { value?: { messages?: WhatsAppText[] } })?.value?.messages ?? [];
      for (const m of messages) {
        const body = m.type === "text" ? m.text?.body?.trim() : undefined;
        if (m.from && body) out.push({ from: m.from, body });
      }
    }
  }
  return out;
}

async function handleMessage(from: string, body: string): Promise<void> {
  const agent = await resolveWhatsAppAgent();
  if (!agent) {
    console.warn("[whatsapp] inbound message but no agent to answer it");
    return;
  }
  // Only auto-reply if the answering agent's owner has WhatsApp in their plan.
  if (!(await getPlanFeatures(agent.userId)).whatsapp) {
    console.warn("[whatsapp] inbound message but owner's plan doesn't include WhatsApp");
    return;
  }
  const history = threads.get(from) ?? [];
  const reply = await generateAgentReply(agent.config, history, body);

  remember(from, { role: "user", content: body });
  remember(from, { role: "assistant", content: reply });

  await sendWhatsApp(from, reply);
}

// --- Inbound messages ---
router.post("/webhook", express.raw({ type: () => true, limit: "2mb" }), (req, res) => {
  const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.from("");
  if (!verifySignature(raw, req.header("x-hub-signature-256"))) {
    res.sendStatus(401);
    return;
  }

  // Always ack fast; Meta retries on non-200 and times out quickly.
  res.sendStatus(200);

  let payload: unknown;
  try {
    payload = JSON.parse(raw.toString("utf8") || "{}");
  } catch {
    return;
  }

  for (const { from, body } of extractTextMessages(payload)) {
    handleMessage(from, body).catch((err) =>
      console.error("[whatsapp] failed to handle message:", err),
    );
  }
});

export default router;
