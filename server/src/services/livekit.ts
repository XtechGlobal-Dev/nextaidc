import { AccessToken, RoomServiceClient, WebhookReceiver } from "livekit-server-sdk";
import type { TicketLane } from "../lib/ticketLanes.js";
import { getEffective, integrationConfiguredFor } from "./settings.js";

// In-ticket voice/video calls. LiveKit hosts the media; we only mint join tokens
// and read its webhooks. Mirrors src/lib/livekit.ts on the client for the call shape.
// Keys come from Settings → Integrations (DB override, env fallback), platform-wide.

export type CallSide = "staff" | "requester";
export type CallMode = "audio" | "video";

export function livekitConfigured(): boolean {
  return integrationConfiguredFor("livekit");
}

function credentials() {
  return {
    url: getEffective("livekit.url").trim(),
    apiKey: getEffective("livekit.apiKey").trim(),
    apiSecret: getEffective("livekit.apiSecret").trim(),
  };
}

const ROOM_PREFIX = "ticket";
const SEP = "__";
const NO_BRAND = "none";

/** Both sides derive the same name from the same ticket, so caller and callee meet
 *  without any signalling of our own. The lane + brand are in the name because a
 *  webhook arrives with no request context — the name alone must pick the DB. */
export function roomNameFor(lane: TicketLane, brandId: string | null | undefined, ticketId: string): string {
  return [ROOM_PREFIX, lane, brandId || NO_BRAND, ticketId].join(SEP);
}

export function parseRoomName(
  name: string,
): { lane: TicketLane; brandId: string | null; ticketId: string } | null {
  const parts = name.split(SEP);
  if (parts.length !== 4 || parts[0] !== ROOM_PREFIX) return null;
  const [, lane, brand, ticketId] = parts;
  if (lane !== "support" && lane !== "brand") return null;
  if (!ticketId) return null;
  return { lane, brandId: brand === NO_BRAND ? null : brand, ticketId };
}

export function participantIdentity(side: CallSide, userId: string): string {
  return `${side}_${userId}`;
}

export function parseParticipantIdentity(identity: string): { side: CallSide; userId: string } | null {
  const i = identity.indexOf("_");
  if (i <= 0) return null;
  const side = identity.slice(0, i);
  if (side !== "staff" && side !== "requester") return null;
  return { side, userId: identity.slice(i + 1) };
}

/** A join token is the whole authorisation: whoever holds it can enter the room, so
 *  it is short-lived and the route minting it must have already checked ticket access. */
export async function mintAccessToken(input: {
  roomName: string;
  side: CallSide;
  userId: string;
  name: string;
  mode: CallMode;
}): Promise<{ token: string; url: string; roomName: string }> {
  const { url, apiKey, apiSecret } = credentials();
  const at = new AccessToken(apiKey, apiSecret, {
    identity: participantIdentity(input.side, input.userId),
    name: input.name,
    // The webhook only sees the participant, so the mode rides along with it.
    metadata: JSON.stringify({ mode: input.mode }),
    ttl: "10m",
  });
  at.addGrant({ roomJoin: true, room: input.roomName, canPublish: true, canSubscribe: true });
  return { token: await at.toJwt(), url, roomName: input.roomName };
}

export function modeFromMetadata(metadata: string | undefined): CallMode {
  try {
    const parsed = JSON.parse(metadata || "{}") as { mode?: unknown };
    return parsed.mode === "video" ? "video" : "audio";
  } catch {
    return "audio";
  }
}

/** Who is in a ticket's call room right now, straight from LiveKit — the one source that survives a
 *  crashed browser. Cached briefly: every open thread asks while a call is on. */
export interface CallParticipant {
  side: CallSide;
  userId: string;
  name: string;
  mode: CallMode;
}

const PARTICIPANTS_TTL_MS = 2_000;
const participantsCache = new Map<string, { at: number; value: CallParticipant[] }>();

export async function listCallParticipants(roomName: string): Promise<CallParticipant[]> {
  const hit = participantsCache.get(roomName);
  if (hit && Date.now() - hit.at < PARTICIPANTS_TTL_MS) return hit.value;
  const { url, apiKey, apiSecret } = credentials();
  let value: CallParticipant[] = [];
  try {
    const svc = new RoomServiceClient(url.replace(/^ws/, "http"), apiKey, apiSecret);
    const rows = await svc.listParticipants(roomName);
    value = rows.flatMap((p) => {
      const id = parseParticipantIdentity(p.identity);
      return id ? [{ ...id, name: p.name, mode: modeFromMetadata(p.metadata) }] : [];
    });
  } catch {
    // A room that does not exist (no call) answers with an error, as does a LiveKit outage:
    // both read as "nobody on a call", which is the safe answer for a header pill.
  }
  participantsCache.set(roomName, { at: Date.now(), value });
  return value;
}

let receiver: { key: string; instance: WebhookReceiver } | null = null;

/** Rebuilt whenever an admin saves new keys, so a rotated secret takes effect without a restart. */
export function webhookReceiver(): WebhookReceiver {
  const { apiKey, apiSecret } = credentials();
  const key = `${apiKey}:${apiSecret}`;
  if (receiver?.key !== key) receiver = { key, instance: new WebhookReceiver(apiKey, apiSecret) };
  return receiver.instance;
}
