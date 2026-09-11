import type { Response } from "express";

/**
 * In-memory Server-Sent Events (SSE) hub. Long-lived Express connections
 * subscribe to one or more channels; write points publish tiny "something
 * changed" events to a channel and every subscribed client is nudged to refresh.
 *
 * Channels:
 *   user:<userId>  — that user's own tabs
 *   admin          — all admin/staff tabs (aggregate dashboards)
 *
 * Events carry only a small `{ type }` tag — never the changed data itself. The
 * client reacts by re-fetching just what the current screen shows, so a burst of
 * activity never balloons into large pushes and idle tabs make zero requests.
 *
 * State is per-process and intentionally ephemeral: if the API restarts, clients
 * transparently reconnect (EventSource auto-retry) and re-subscribe. This works
 * because the API runs as a single long-lived server; it is NOT safe to assume
 * cross-instance delivery if the API is ever horizontally scaled (see NOTE).
 */

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

/**
 * Tell admin/staff tabs that someone came online or went offline.
 *
 * Presence is derived from open streams, so it changes without any write to the
 * database — nothing else publishes for it, and an admin watching the customer
 * list would otherwise see a stale dot until some unrelated activity happened to
 * push an event (or they reloaded the page). Admins only: presence is not a
 * customer's own business, and this keeps the customer's channel quiet.
 */
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

/**
 * Ids of every user with at least one open stream — i.e. who has the app open
 * right now. Derived from the live client map (each client subscribes to its own
 * `user:<id>` channel), so presence costs nothing extra: no polling, no writes,
 * no new table.
 *
 * Reflects only THIS process's connections (see the scaling note below) and only
 * an app tab being open — a background tab still counts as online, which is the
 * usual meaning elsewhere. After a restart everyone reads offline until the
 * browsers reconnect (~5s, the client's `retry` hint).
 *
 * Impersonated sessions are excluded: an admin opening a customer's panel must
 * never make that customer look like they're here.
 */
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

// NOTE: horizontal scaling — if the API is ever run as more than one instance,
// swap this in-memory hub for a shared bus (Redis pub/sub, Postgres LISTEN/NOTIFY)
// so an event published on instance A reaches a client connected to instance B.
// The publish/subscribe surface above is deliberately small to make that swap easy.
