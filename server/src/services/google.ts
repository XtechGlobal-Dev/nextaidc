import { prisma } from "../prisma.js";
import { getEffective, integrationsStatus } from "./settings.js";
import { encryptSecret, decryptSecret } from "../lib/crypto.js";
import { traceFetch } from "./apiTrace.js";
import { canonicalApiBaseUrl, env } from "../env.js";

// One redirect URI for every tenant, never the brand's domain — Google only accepts
// pre-registered URIs. The callback bounces to the origin carried in the signed `state`.
function redirectUri(): string {
  const configured = getEffective("google.redirectUri").trim();
  if (configured) return configured;
  if (env.GOOGLE_REDIRECT_URI.trim()) return env.GOOGLE_REDIRECT_URI;
  return `${canonicalApiBaseUrl}/api/google/callback`;
}

/** The callback URI to register in the Google Cloud console, surfaced in admin. */
export function googleCallbackUri(): string {
  return redirectUri();
}

// Google Calendar OAuth. Tokens live encrypted in PlatformSetting under
// "google.tokens.<userId>" — no schema migration needed.

export interface GoogleTokens {
  accessToken: string;
  refreshToken?: string;
  email?: string;
  savedAt?: number;
}

const SCOPES = [
  "https://www.googleapis.com/auth/calendar.events",
  "https://www.googleapis.com/auth/userinfo.email",
].join(" ");

export function isGoogleConfigured(): boolean {
  return integrationsStatus().google;
}

export function buildAuthUrl(state: string): string {
  const params = new URLSearchParams({
    client_id: getEffective("google.clientId"),
    redirect_uri: redirectUri(),
    response_type: "code",
    scope: SCOPES,
    access_type: "offline",
    prompt: "consent",
    include_granted_scopes: "true",
    state,
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
}

export async function exchangeCode(
  code: string,
): Promise<{ access_token: string; refresh_token?: string; expires_in: number }> {
  const body = new URLSearchParams({
    code,
    client_id: getEffective("google.clientId"),
    client_secret: getEffective("google.clientSecret"),
    redirect_uri: redirectUri(),
    grant_type: "authorization_code",
  });
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`Google token exchange failed (${res.status}): ${detail}`);
  }
  return res.json() as Promise<{ access_token: string; refresh_token?: string; expires_in: number }>;
}

export async function fetchGoogleEmail(accessToken: string): Promise<string> {
  try {
    const res = await fetch("https://www.googleapis.com/oauth2/v2/userinfo", {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!res.ok) return "";
    const data = (await res.json()) as { email?: string };
    return data.email || "";
  } catch {
    return "";
  }
}

function tokensKey(userId: string): string {
  return `google.tokens.${userId}`;
}

export async function saveTokens(userId: string, tokens: GoogleTokens): Promise<void> {
  const value = encryptSecret(JSON.stringify({ ...tokens, savedAt: Date.now() }));
  await prisma.platformSetting.upsert({
    where: { key: tokensKey(userId) },
    update: { value, isSecret: true },
    create: { key: tokensKey(userId), value, isSecret: true },
  });
}

export async function getTokens(userId: string): Promise<GoogleTokens | null> {
  try {
    const row = await prisma.platformSetting.findUnique({ where: { key: tokensKey(userId) } });
    if (!row) return null;
    return JSON.parse(decryptSecret(row.value)) as GoogleTokens;
  } catch {
    return null;
  }
}

export async function clearTokens(userId: string): Promise<void> {
  await prisma.platformSetting.deleteMany({ where: { key: tokensKey(userId) } });
}

/** Refresh an expired access token using a stored refresh token. */
async function refreshAccessToken(refreshToken: string): Promise<string | null> {
  try {
    const body = new URLSearchParams({
      refresh_token: refreshToken,
      client_id: getEffective("google.clientId"),
      client_secret: getEffective("google.clientSecret"),
      grant_type: "refresh_token",
    });
    const res = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { access_token?: string };
    return data.access_token || null;
  } catch {
    return null;
  }
}

// Authenticated fetch; refreshes once on 401 and retries. Null when not connected.
async function googleFetch(
  userId: string,
  path: string,
  init: RequestInit,
): Promise<Response | null> {
  if (!isGoogleConfigured()) return null;
  const tokens = await getTokens(userId);
  if (!tokens?.accessToken) return null;

  const call = (accessToken: string) =>
    traceFetch("google", `https://www.googleapis.com/calendar/v3${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
        ...(init.headers ?? {}),
      },
    });

  let res = await call(tokens.accessToken);
  if (res.status === 401 && tokens.refreshToken) {
    const fresh = await refreshAccessToken(tokens.refreshToken);
    if (fresh) {
      await saveTokens(userId, { ...tokens, accessToken: fresh });
      res = await call(fresh);
    }
  }
  return res;
}

/** A busy interval on a calendar (ISO datetimes carrying an offset). */
export interface BusyInterval {
  start: string;
  end: string;
}

/** Busy intervals over a window. Uses events.list, not freeBusy — freeBusy needs the broad calendar scope we don't request (403). All-day events are ignored so one can't wipe every slot; returns [] on error. */
export async function getFreeBusy(
  userId: string,
  timeMinISO: string,
  timeMaxISO: string,
  calendarIds: string[] = ["primary"],
): Promise<BusyInterval[]> {
  const busy: BusyInterval[] = [];
  try {
    for (const rawId of calendarIds.length ? calendarIds : ["primary"]) {
      const cal = encodeURIComponent(rawId.trim() || "primary");
      const params = new URLSearchParams({
        timeMin: timeMinISO,
        timeMax: timeMaxISO,
        singleEvents: "true", // expand recurring events into instances
        orderBy: "startTime",
        showDeleted: "false",
        maxResults: "2500",
      });
      const res = await googleFetch(userId, `/calendars/${cal}/events?${params.toString()}`, {
        method: "GET",
      });
      if (!res || !res.ok) {
        if (res) {
          const detail = await res.text().catch(() => "");
          console.warn(
            `[calendar] events.list ${res.status} for user ${userId}: ${detail.slice(0, 200)}`,
          );
        }
        continue;
      }
      const data = (await res.json()) as {
        items?: {
          status?: string;
          transparency?: string;
          start?: { dateTime?: string; date?: string };
          end?: { dateTime?: string; date?: string };
        }[];
      };
      for (const e of data.items ?? []) {
        if (e.status === "cancelled") continue; // deleted/declined
        if (e.transparency === "transparent") continue; // shown as "free"
        const start = e.start?.dateTime;
        const end = e.end?.dateTime;
        if (start && end) busy.push({ start, end }); // timed events only
      }
    }
    return busy;
  } catch (e) {
    console.error(`[calendar] busy lookup threw for user ${userId}:`, e);
    return busy;
  }
}

/** Deletes an event and emails attendees (sendUpdates=all). Never throws. */
export async function deleteCalendarEvent(
  userId: string,
  eventId: string,
  calendarId = "primary",
): Promise<{ ok: boolean }> {
  try {
    if (!eventId.trim()) return { ok: false };
    const cal = encodeURIComponent(calendarId.trim() || "primary");
    const res = await googleFetch(
      userId,
      `/calendars/${cal}/events/${encodeURIComponent(eventId)}?sendUpdates=all`,
      { method: "DELETE" },
    );
    // 410 Gone = already deleted; treat as success so a cancel is idempotent.
    if (res && (res.ok || res.status === 410)) return { ok: true };
    if (res) {
      const detail = await res.text().catch(() => "");
      console.warn(`[calendar] delete ${res.status} for user ${userId}: ${detail.slice(0, 200)}`);
    }
    return { ok: false };
  } catch (e) {
    console.error(`[calendar] delete threw for user ${userId}:`, e);
    return { ok: false };
  }
}

/** Moves an event to a new start/end and emails attendees. Never throws. */
export async function patchCalendarEventTime(
  userId: string,
  eventId: string,
  startISO: string,
  endISO: string,
  opts?: { calendarId?: string; timeZone?: string },
): Promise<{ ok: boolean }> {
  try {
    if (!eventId.trim()) return { ok: false };
    const cal = encodeURIComponent(opts?.calendarId?.trim() || "primary");
    const start: Record<string, string> = { dateTime: startISO };
    const end: Record<string, string> = { dateTime: endISO };
    if (opts?.timeZone?.trim()) {
      start.timeZone = opts.timeZone.trim();
      end.timeZone = opts.timeZone.trim();
    }
    const res = await googleFetch(
      userId,
      `/calendars/${cal}/events/${encodeURIComponent(eventId)}?sendUpdates=all`,
      { method: "PATCH", body: JSON.stringify({ start, end }) },
    );
    if (res && res.ok) return { ok: true };
    if (res) {
      const detail = await res.text().catch(() => "");
      console.warn(`[calendar] patch ${res.status} for user ${userId}: ${detail.slice(0, 200)}`);
    }
    return { ok: false };
  } catch (e) {
    console.error(`[calendar] patch threw for user ${userId}:`, e);
    return { ok: false };
  }
}

export interface CalendarEvent {
  summary: string;
  description?: string;
  startISO: string;
  endISO: string;
  /** Calendar to write to; defaults to the user's primary calendar. */
  calendarId?: string;
  /** IANA timezone; when omitted Google uses the offset in the ISO datetimes. */
  timeZone?: string;
  /** Caller's email; when set they get a native Google invite. */
  attendeeEmail?: string;
}

async function postCalendarEvent(accessToken: string, evt: CalendarEvent): Promise<Response> {
  const calendarId = encodeURIComponent(evt.calendarId?.trim() || "primary");
  // sendUpdates=all → Google emails every attendee a native invite + reminders.
  const url = `https://www.googleapis.com/calendar/v3/calendars/${calendarId}/events?sendUpdates=all`;
  const start: Record<string, string> = { dateTime: evt.startISO };
  const end: Record<string, string> = { dateTime: evt.endISO };
  if (evt.timeZone?.trim()) {
    start.timeZone = evt.timeZone.trim();
    end.timeZone = evt.timeZone.trim();
  }
  return fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      summary: evt.summary,
      description: evt.description,
      start,
      end,
      ...(evt.attendeeEmail?.trim()
        ? { attendees: [{ email: evt.attendeeEmail.trim() }] }
        : {}),
    }),
  });
}

/** Turn a raw Google error body + status into a short, human-readable reason. */
function parseGoogleError(status: number, detail: string): string {
  try {
    const j = JSON.parse(detail) as { error?: { message?: string; errors?: { reason?: string }[] } };
    const msg = j.error?.message?.trim();
    const reason = j.error?.errors?.[0]?.reason?.trim();
    if (msg) return reason ? `${msg} (${reason})` : msg;
  } catch {
    /* not JSON */
  }
  const snippet = detail.replace(/\s+/g, " ").trim().slice(0, 160);
  return snippet ? `Google API ${status}: ${snippet}` : `Google API error ${status}`;
}

/** Creates an event, optionally inviting the caller. No-op when unconfigured; `error` is a short human reason. */
export async function createCalendarEvent(
  userId: string,
  evt: CalendarEvent,
): Promise<{ ok: boolean; id?: string; error?: string }> {
  try {
    if (!isGoogleConfigured()) {
      console.warn("[calendar] not configured — skipping event creation");
      return { ok: false, error: "Google Calendar isn't configured on the server." };
    }
    const tokens = await getTokens(userId);
    if (!tokens?.accessToken) {
      console.warn(`[calendar] no tokens for user ${userId} — skipping`);
      return { ok: false, error: "No Google authorization found — please reconnect your calendar." };
    }

    let accessToken = tokens.accessToken;
    let res = await postCalendarEvent(accessToken, evt);

    if (res.status === 401 && tokens.refreshToken) {
      const fresh = await refreshAccessToken(tokens.refreshToken);
      if (!fresh) {
        console.warn(`[calendar] token refresh failed for user ${userId}`);
        return {
          ok: false,
          error: "Your Google session expired and couldn't be refreshed — please reconnect your calendar.",
        };
      }
      await saveTokens(userId, { ...tokens, accessToken: fresh });
      accessToken = fresh;
      res = await postCalendarEvent(accessToken, evt);
    } else if (res.status === 401) {
      return {
        ok: false,
        error: "Google rejected the authorization (no refresh token) — please reconnect your calendar.",
      };
    }

    // Many Workspace accounts block external attendees (403). Retry without the
    // invite so the booking still lands on the owner's calendar.
    if (!res.ok && evt.attendeeEmail?.trim()) {
      const detail = await res.text().catch(() => "");
      console.warn(
        `[calendar] Google API ${res.status} with attendee for user ${userId} (${detail.slice(0, 200)}) — retrying without invite`,
      );
      res = await postCalendarEvent(accessToken, { ...evt, attendeeEmail: undefined });
    }

    if (!res.ok) {
      // Surface the exact Google error so calendar failures are debuggable
      // instead of a silent no-op.
      const detail = await res.text().catch(() => "");
      console.error(`[calendar] Google API ${res.status} for user ${userId}: ${detail}`);
      return { ok: false, error: parseGoogleError(res.status, detail) };
    }
    const data = (await res.json()) as { id?: string };
    console.log(`[calendar] event created ${data.id ?? ""} for user ${userId}`);
    return { ok: true, id: data.id };
  } catch (e) {
    console.error(`[calendar] event creation threw for user ${userId}:`, e);
    return { ok: false, error: e instanceof Error ? e.message : "Unexpected error creating the event." };
  }
}
