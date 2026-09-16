import express from "express";
import { z } from "zod";
import type { ChatConversation, ChatMessage, PrismaClient as TenantClient } from "@prisma/tenant-client";
import { asyncHandler } from "../lib/http.js";
import { requireAuth } from "../middleware/auth.js";
import { requestTenant } from "../services/tenantDb.js";
import { generateSupportReply } from "../services/chatAssistant.js";
import { supportHandoffEmail, handoffAckEmail, supportInboxAddress } from "../services/email.js";
import { brandDisplayName } from "../lib/brandUrls.js";

/* A customer's support-chat thread lives in their brand's own database
 * (phase 2b): every route here opens that first. */

const router = express.Router();

router.use(requireAuth);

/** Resolved per request, not once at import: on a brand's front door the
 *  assistant introduces itself as that brand, never as the platform. */
const welcomeMessage = () =>
  `Hi! 👋 I'm the ${brandDisplayName()} support assistant. How can I help you set up your AI receptionist?`;

/** Find (or create) the user's chat conversation, with messages ordered oldest-first. */
async function getOrCreateConversation(
  db: TenantClient,
  userId: string,
): Promise<ChatConversation & { messages: ChatMessage[] }> {
  const existing = await db.chatConversation.findFirst({
    where: { userId },
    include: { messages: { orderBy: { createdAt: "asc" } } },
  });
  if (existing) return existing;

  return db.chatConversation.create({
    data: {
      userId,
      messages: {
        create: { role: "assistant", content: welcomeMessage() },
      },
    },
    include: { messages: { orderBy: { createdAt: "asc" } } },
  });
}

router.get(
  "/",
  asyncHandler(async (req, res) => {
    const db = await requestTenant(req);
    const { messages, ...conversation } = await getOrCreateConversation(db, req.user!.sub);
    res.json({ conversation, messages });
  }),
);

const postSchema = z.object({
  content: z.string().min(1),
});

router.post(
  "/messages",
  asyncHandler(async (req, res) => {
    const { content } = postSchema.parse(req.body);
    const db = await requestTenant(req);
    const conversation = await getOrCreateConversation(db, req.user!.sub);

    const userMsg = await db.chatMessage.create({
      data: { conversationId: conversation.id, role: "user", content },
    });

    let { reply, handoff } = await generateSupportReply(
      conversation.messages.map((m) => ({ role: m.role, content: m.content })),
      content,
      conversation.messages.length,
    );

    // Deliver the handoff. If the send fails, swap the "sent!" reply for an honest fallback.
    if (handoff) {
      try {
        const user = await db.user.findUnique({ where: { id: req.user!.sub } });
        await supportHandoffEmail({
          accountEmail: user?.email ?? "",
          accountName: user?.fullName ?? "",
          details: handoff,
          transcript: [
            ...conversation.messages.map((m) => ({ role: m.role, content: m.content })),
            { role: "user", content },
          ],
        });
        await db.chatConversation.update({
          where: { id: conversation.id },
          data: { humanTakeover: true },
        });
        // Best-effort ack to the customer (given address, else account email) — the team already has the handoff.
        const customerEmail = (handoff.email || user?.email || "").trim();
        if (customerEmail) {
          void handoffAckEmail({
            to: customerEmail,
            name: handoff.name || user?.fullName || "there",
            topic: handoff.topic,
            summary: handoff.summary,
          }).catch((err) => console.error("[chat] handoff ack email failed:", err));
        }
      } catch (err) {
        console.error("[chat] support handoff email failed:", err);
        reply =
          "Sorry — I couldn't reach our support team automatically just now. " +
          `Please email us directly at ${supportInboxAddress()} and we'll get back to you.`;
      }
    }

    const assistantMsg = await db.chatMessage.create({
      data: { conversationId: conversation.id, role: "assistant", content: reply },
    });

    res.json({ messages: [userMsg, assistantMsg] });
  }),
);

export default router;
