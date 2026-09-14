import type { Response } from "express";

// In-memory SSE hub. Channels: `user:<id>` and `admin`. Events carry only a `{ type }`
// tag, never data — clients re-fetch. Per-process state; see the scaling note at the bottom.

type Client = {
  id: number;
  channels: Set<string>;
  res: Response;
  /** Session opened by admin impersonation. Receives events exactly like a real
   *  session — it just doesn't count as the customer being present. */
  impersonated: boolean;
};

export interface LiveEvent {
  type: string;
  [key: string]: unknown;
}

const clients = new Map<number, Client>();
let nextId = 1;

/** The user a client counts as present for, or null when it doesn't count — an
 *  impersonated session is a real stream but never means the customer is here. */
function presenceUserOf(channels: Iterable<string>, impersonated: boolean): string | null {
  if (impersonated) return null;
  for (const ch of channels) if (ch.startsWith("user:")) return ch.slice("user:".length);
  return null;
}

/** Does this user have any stream open right now? */
function isOnline(userId: string): boolean {
  for (const c of clients.values()) {
    if (presenceUserOf(c.channels, c.impersonated) === userId) return true;
  }
  return false;
}

export function addClient(
  res: Response,
  channels: string[],
  opts: { impersonated?: boolean } = {},
): number {
  const id = nextId++;
  const impersonated = opts.impersonated ?? false;
  const presenceId = presenceUserOf(channels, impersonated);
  // Sampled BEFORE inserting: only the first stream flips someone online, so a
  // second tab doesn't re-announce presence that hasn't changed.
  const wasOnline = presenceId !== null && isOnline(presenceId);
  clients.set(id, { id, channels: new Set(channels), res, impersonated });
  if (presenceId !== null && !wasOnline) announcePresence(presenceId, true);
  return id;
}

export function removeClient(id: number): void {
  const c = clients.get(id);
  if (!c) return; // already gone — cleanup() is called from several disconnect paths
  const presenceId = presenceUserOf(c.channels, c.impersonated);
  clients.delete(id);
  // Only once the LAST stream closes: closing one of three open tabs is not
  // going offline.
  if (presenceId !== null && !isOnline(presenceId)) announcePresence(presenceId, false);
}

// Presence comes from open streams, not DB writes, so nothing else would publish it.
// Admins only — it's not the customer's business and keeps their channel quiet.
function announcePresence(userId: string, online: boolean): void {
  publishToAdmins({ type: "presence", userId, online });
}

/** Write one event to every client subscribed to `channel`. Best-effort. */
export function publish(channel: string, event: LiveEvent): void {
  const payload = `data: ${JSON.stringify(event)}\n\n`;
  for (const c of clients.values()) {
    if (!c.channels.has(channel)) continue;
    try {
      c.res.write(payload);
    } catch {
      // A dead socket will be cleaned up by its own 'close' handler; ignore here.
    }
  }
}

export function publishToUser(userId: string, event: LiveEvent): void {
  publish(`user:${userId}`, event);
}

export function publishToAdmins(event: LiveEvent): void {
  publish("admin", event);
}

/** Number of currently-connected SSE clients (exposed for health/debug). */
export function liveClientCount(): number {
  return clients.size;
}

/** Users with an open stream in THIS process. Impersonated sessions excluded — an admin viewing a customer must never make them look present. */
export function onlineUserIds(): Set<string> {
  const ids = new Set<string>();
  for (const c of clients.values()) {
    if (c.impersonated) continue;
    for (const ch of c.channels) {
      if (ch.startsWith("user:")) ids.add(ch.slice("user:".length));
    }
  }
  return ids;
}

// NOTE: not safe across instances. If the API ever scales horizontally, swap this
// for a shared bus (Redis pub/sub, Postgres LISTEN/NOTIFY); the surface is small on purpose.
