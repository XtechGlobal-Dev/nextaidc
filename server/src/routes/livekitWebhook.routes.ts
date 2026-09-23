import express from "express";
import type { WebhookEvent } from "livekit-server-sdk";
import { asyncHandler } from "../lib/http.js";
import { laneCopy } from "../lib/ticketLanes.js";
import { laneDb } from "../services/tenantDb.js";
import { publishToAdmins, publishToUser } from "../services/events.js";
import {
  livekitConfigured,
  modeFromMetadata,
  parseParticipantIdentity,
  parseRoomName,
  webhookReceiver,
} from "../services/livekit.js";
import { appendMessage, ticketInclude, withRequester } from "../services/tickets.js";

// LiveKit tells us when a call room gains its first participant and when it closes.
// Those two moments are the call record: a system line in the thread each. Ringing
// and hang-ups are signalled by the clients themselves (routes …/call/ring, …/call/end)
// so they don't depend on this webhook being reachable. No request context here —
// the room name picks the DB.

const router = express.Router();

function durationLabel(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

async function handle(event: WebhookEvent): Promise<void> {
  if (event.event !== "participant_joined" && event.event !== "room_finished") return;
  const room = event.room;
  if (!room) return;
  const target = parseRoomName(room.name);
  if (!target) return;

  const db = await laneDb(target.lane, target.brandId);
  const row = await db.ticket.findUnique({ where: { id: target.ticketId }, include: ticketInclude });
  if (!row || (row.brandId ?? null) !== target.brandId) return;
  const ticket = withRequester(row);

  if (event.event === "participant_joined") {
    // Only the first participant is "the caller"; the second is the answer.
    if (room.numParticipants > 1) return;
    const who = event.participant;
    const identity = who ? parseParticipantIdentity(who.identity) : null;
    if (!who || !identity) return;

    const mode = modeFromMetadata(who.metadata);
    const name =
      who.name ||
      (identity.side === "staff" ? laneCopy(target.lane).handlerLabel : ticket.requester.fullName);

    await appendMessage(db, {
      ticketId: ticket.id,
      authorType: "system",
      authorName: "Call",
      body: `${name} started a ${mode === "video" ? "video" : "voice"} call.`,
    });
    const changed = { type: "ticket", ticketId: ticket.id };
    publishToUser(ticket.requesterId, changed);
    publishToAdmins(changed);
    return;
  }

  // Rooms close a while after emptying, so this can land during the NEXT call on the
  // same ticket — it must only refresh the thread, never signal "the call ended".
  const startedMs = Number(room.creationTime) * 1000;
  await appendMessage(db, {
    ticketId: ticket.id,
    authorType: "system",
    authorName: "Call",
    body: `Call ended · ${durationLabel(Date.now() - startedMs)}`,
  });
  const changed = { type: "ticket", ticketId: ticket.id };
  publishToUser(ticket.requesterId, changed);
  publishToAdmins(changed);
}

router.post(
  "/",
  express.raw({ type: "*/*" }),
  asyncHandler(async (req, res) => {
    if (!livekitConfigured()) {
      res.json({ received: true });
      return;
    }

    let event: WebhookEvent;
    try {
      const raw = Buffer.isBuffer(req.body) ? req.body.toString("utf8") : String(req.body ?? "");
      event = await webhookReceiver().receive(raw, req.get("Authorization"));
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : "Invalid webhook signature" });
      return;
    }

    try {
      await handle(event);
    } catch (err) {
      // Acknowledge regardless — LiveKit retries a non-2xx, and a poison event would loop forever.
      console.warn("[livekit] webhook failed:", err instanceof Error ? err.message : err);
    }
    res.json({ received: true });
  }),
);

export default router;
