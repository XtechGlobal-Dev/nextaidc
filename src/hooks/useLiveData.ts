import { useEffect, useState } from "react";
import { env } from "@/lib/env";
import { getToken } from "@/lib/api";
import { useAuthStore } from "@/stores/useAuthStore";
import { useLiveStore } from "@/stores/useLiveStore";
import { useTrialStore } from "@/stores/useTrialStore";
import { useProfileStore } from "@/stores/useProfileStore";
import { useNotificationStore } from "@/stores/useNotificationStore";

// A burst of server events (busy call, admin flurry) should cause one re-fetch, not one per event.
const COALESCE_MS = 400;

// Used ONLY while the SSE stream is down (buffering proxy, mid-reconnect). With a
// healthy stream an idle tab makes zero requests.
const FALLBACK_POLL_MS = 30_000;

/** The single live-refresh driver — mount once in AppLayout. SSE pushes a "something changed"
 *  tag, we bump the useLiveStore tick and pages re-fetch their own data; slow poll only while disconnected. */
export function useLiveData() {
  const status = useAuthStore((s) => s.status);
  // Keyed on identity: impersonation swaps the token while status stays "authed", which
  // left the stream on the PREVIOUS account's channel and the panel stuck on the 30s poll.
  const userId = useAuthStore((s) => s.user?.id);

  useEffect(() => {
    if (status !== "authed") return;

    let connected = false;
    let coalesceTimer: number | undefined;

    // Trial/profile only for USER accounts — admins aren't trial-gated and don't show
    // usage in the chrome.
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
      // Every event is just a type tag → coalesced refresh. Except typing nudges: nothing is
      // stored to re-fetch, and refreshing per keystroke would be a request storm.
      es.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data) as {
            type?: string;
            ticketId?: string;
            name?: string;
            mode?: string;
            fromName?: string;
            to?: string;
            link?: string;
            reason?: string;
          };
          if (data?.type === "ticket-typing" && data.ticketId) {
            useLiveStore.getState().noteTyping(data.ticketId, data.name || "Someone");
            return;
          }
          // A ring must be instant, and the call-started line it comes with still
          // needs the normal refresh — so note it, then fall through.
          if (data?.type === "call-invite" && data.ticketId && data.link) {
            useLiveStore.getState().noteCallInvite({
              ticketId: data.ticketId,
              mode: data.mode === "video" ? "video" : "audio",
              fromName: data.fromName || "Someone",
              to: data.to === "staff" ? "staff" : "requester",
              link: data.link,
            });
            return;
          }
          if (data?.type === "call-ended" && data.ticketId) {
            const live = useLiveStore.getState();
            live.clearCallInvite(data.ticketId);
            live.noteCallEnded({
              ticketId: data.ticketId,
              reason: data.reason || "hangup",
              fromName: data.fromName || "The other side",
            });
            return;
          }
        } catch {
          // Not JSON / odd shape — fall through to a plain refresh.
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

/** Global live tick — add it to a loader effect's deps so the page re-fetches on pushed activity. */
export function useLiveTick(): number {
  return useLiveStore((s) => s.tick);
}

/** How long a typing nudge stands before it expires by itself. The sender
 *  re-pings every 3s while they are actually typing, so this outlives one gap. */
const TYPING_TTL_MS = 5000;

/** "X is typing…" for one ticket, or null. Nobody signals a STOP — they just stop pinging —
 *  so a local timer re-renders once the last nudge is older than TYPING_TTL_MS. */
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
