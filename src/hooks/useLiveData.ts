import { useEffect, useState } from "react";
import { env } from "@/lib/env";
import { getToken } from "@/lib/api";
import { useAuthStore } from "@/stores/useAuthStore";
import { useLiveStore } from "@/stores/useLiveStore";
import { useTrialStore } from "@/stores/useTrialStore";
import { useProfileStore } from "@/stores/useProfileStore";
import { useNotificationStore } from "@/stores/useNotificationStore";

// How long to coalesce a burst of server events into a single refresh. A busy
// call or a flurry of admin activity fires several notifications back-to-back;
// we only want one re-fetch, not one per event.
const COALESCE_MS = 400;

// Fallback poll cadence — used ONLY while the SSE stream is not connected (e.g.
// a proxy that buffers, a dropped connection mid-reconnect). While the stream is
// healthy, an idle tab makes zero requests: updates are pushed, not polled.
const FALLBACK_POLL_MS = 30_000;

/**
 * The single live-refresh driver for the whole authenticated app. Mount once
 * (in {@link AppLayout}).
 *
 * Primary path is a Server-Sent Events stream: the API pushes a tiny "something
 * changed" event only when real activity happens (a call lands, a signup, an
 * approval), and we bump the global {@link useLiveStore} tick. Pages refresh
 * **their own** data by depending on {@link useLiveTick}, so we re-fetch only
 * what the current screen shows — and an idle tab is completely silent.
 *
 * A slow fallback poll runs only while the stream is disconnected, so the app
 * still self-heals if SSE can't establish (buffering proxy, network blip).
 */
export function useLiveData() {
  const status = useAuthStore((s) => s.status);
  // Identity, not just signed-in-ness. Entering/leaving a customer's panel swaps
  // the token while `status` stays "authed", so keying on status alone left the
  // stream authenticated as the PREVIOUS account — subscribed to the wrong
  // `user:` channel, so the panel you're looking at received no pushes and fell
  // back to the 30s poll. Re-running on the user id reconnects as whoever is
  // active now.
  const userId = useAuthStore((s) => s.user?.id);

  useEffect(() => {
    if (status !== "authed") return;

    let connected = false;
    let coalesceTimer: number | undefined;

    // Re-hydrate the always-mounted chrome + notifications, then tick every
    // live-aware page so it reloads its own data. Trial/profile only matter for
    // customer (USER) accounts — admins aren't trial-gated and don't show usage
    // in the chrome, so their idle pages stay lean.
    const doRefresh = () => {
      useLiveStore.getState().bump();
      void useNotificationStore.getState().hydrate();
      if (useAuthStore.getState().user?.role === "USER") {
        void useTrialStore.getState().hydrate();
        void useProfileStore.getState().hydrate();
      }
    };

    // Coalesce a burst of SSE events into one refresh.
    const scheduleRefresh = () => {
      if (coalesceTimer !== undefined) return;
      coalesceTimer = window.setTimeout(() => {
        coalesceTimer = undefined;
        doRefresh();
      }, COALESCE_MS);
    };

    // --- SSE stream -------------------------------------------------------
    const token = getToken();
    let es: EventSource | null = null;
    if (token) {
      es = new EventSource(
        `${env.apiUrl}/api/events/stream?token=${encodeURIComponent(token)}`,
      );
      es.onopen = () => {
        connected = true;
      };
      // Any pushed event (including the initial "connected") triggers a coalesced
      // refresh — the payload is only a type tag, the data is pulled by the pages.
      // Any pushed event triggers a coalesced refresh — the payload is only a
      // type tag, and the pages pull the data. The one exception is a typing
      // nudge: a keystroke is never written down, so there is nothing to
      // re-fetch for it. It carries its own (tiny) payload into the store and
      // deliberately does NOT schedule a refresh — reloading a thread on every
      // keystroke of the other party would be a request storm for nothing.
      es.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data) as {
            type?: string;
            ticketId?: string;
            name?: string;
          };
          if (data?.type === "ticket-typing" && data.ticketId) {
            useLiveStore.getState().noteTyping(data.ticketId, data.name || "Someone");
            return;
          }
        } catch {
          // Not JSON, or an unexpected shape — fall through to a plain refresh,
          // which is what every other event wants anyway.
        }
        scheduleRefresh();
      };
      es.onerror = () => {
        // EventSource auto-reconnects; mark disconnected so the fallback covers
        // the gap until onopen fires again.
        connected = false;
      };
    }

    // --- Fallback poll (only while the stream is down) --------------------
    const fallbackId = window.setInterval(() => {
      if (!connected && document.visibilityState === "visible") doRefresh();
    }, FALLBACK_POLL_MS);

    // Returning to the tab always does one immediate refresh (cheap, expected),
    // regardless of stream state.
    const onFocus = () => {
      if (document.visibilityState === "visible") doRefresh();
    };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onFocus);

    return () => {
      es?.close();
      window.clearInterval(fallbackId);
      if (coalesceTimer !== undefined) window.clearTimeout(coalesceTimer);
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onFocus);
    };
  }, [status, userId]);
}

/**
 * Subscribe to the global live tick. Add the returned value to a data-loading
 * effect's dependency array so the loader re-runs whenever real activity is
 * pushed from the server — refreshing only the data that page shows:
 *
 *   const liveTick = useLiveTick();
 *   useEffect(() => { void load(); }, [load, liveTick]);
 */
export function useLiveTick(): number {
  return useLiveStore((s) => s.tick);
}

/** How long a typing nudge stands before it expires by itself. The sender
 *  re-pings every 3s while they are actually typing, so this outlives one gap. */
const TYPING_TTL_MS = 5000;

/**
 * "Support is typing…" for one ticket, or null.
 *
 * Nothing tells us when someone STOPS typing — they just stop pinging — so the
 * label expires on its own: a local timer re-renders once the last nudge is
 * older than {@link TYPING_TTL_MS}.
 */
export function useTypingIndicator(ticketId: string | null | undefined): string | null {
  const entry = useLiveStore((s) => (ticketId ? s.typing[ticketId] : undefined));
  const [, setNow] = useState(0);

  useEffect(() => {
    if (!entry) return;
    const remaining = entry.at + TYPING_TTL_MS - Date.now();
    if (remaining <= 0) return;
    const id = window.setTimeout(() => setNow(Date.now()), remaining + 50);
    return () => window.clearTimeout(id);
  }, [entry]);

  if (!entry || Date.now() - entry.at > TYPING_TTL_MS) return null;
  return `${entry.label} is typing…`;
}
