import { useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { Phone, PhoneOff, Video } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ticketInitials } from "@/components/tickets/ticketUi";
import { api } from "@/lib/api";
import { startRingtone } from "@/lib/callTones";
import { adminHref } from "@/lib/onboardingRoute";
import { useAuthStore } from "@/stores/useAuthStore";
import { useLiveStore } from "@/stores/useLiveStore";

// The ring: a dialog in the middle of the screen, over whatever page the call lands on, with the
// caller's name, what the call is about and Accept / Reject. Mounted once in AppLayout so a call
// reaches you anywhere; accepting opens the ticket with ?answer=<mode>, which the ticket page turns
// into a joined call. Nothing but the two buttons closes it — a ring is not something to click past.

/** A ring older than this is stale — the caller has given up by then. */
const RING_TTL_MS = 60_000;

export function IncomingCallToast() {
  const invite = useLiveStore((s) => s.callInvite);
  const clear = useLiveStore((s) => s.clearCallInvite);
  const role = useAuthStore((s) => s.user?.role);
  const navigate = useNavigate();

  const ticketId = invite?.ticketId;
  const at = invite?.at ?? 0;
  const live = Boolean(invite) && Date.now() - at < RING_TTL_MS;

  useEffect(() => {
    if (!live || !ticketId) return;
    const stop = startRingtone();
    const expiry = window.setTimeout(() => clear(ticketId), RING_TTL_MS - (Date.now() - at));
    return () => {
      stop();
      window.clearTimeout(expiry);
    };
  }, [live, ticketId, at, clear]);

  useEffect(() => {
    if (invite && live) console.info("[call] ring dialog shown for ticket", invite.ticketId);
  }, [invite, live]);

  if (!invite || !live) return null;

  const sideApi = invite.to === "staff" ? api.admin.tickets : api.tickets;
  const video = invite.mode === "video";
  const ModeIcon = video ? Video : Phone;

  function reject() {
    if (!invite) return;
    void sideApi.callEnd(invite.ticketId, "declined").catch(() => {});
    clear(invite.ticketId);
  }

  function accept() {
    if (!invite) return;
    clear(invite.ticketId);
    // Picked up here: this account's other tabs and browsers (and colleagues rung alongside) stop
    // ringing. Left ringing, a second pick-up would join the room under the same identity and LiveKit
    // would drop this one out of the call.
    void sideApi.callAnswered(invite.ticketId).catch(() => {});
    const link = `${invite.link}&answer=${invite.mode}`;
    navigate(link.startsWith("/dashboard/admin") ? adminHref(link, role) : link);
  }

  return (
    <div
      role="alertdialog"
      aria-modal="true"
      aria-label={`Incoming ${video ? "video" : "voice"} call from ${invite.fromName}`}
      // Above the call window (1300): a ring must be reachable even mid-call.
      className="fixed inset-0 z-[1310] flex items-center justify-center bg-black/50 p-4 backdrop-blur-sm"
    >
      <div className="flex w-full max-w-sm flex-col items-center rounded-3xl border border-border bg-background px-6 pb-7 pt-9 text-center shadow-2xl">
        {/* The caller, ringing. */}
        <div className="relative mb-5">
          <span className="absolute inset-0 animate-ping rounded-full bg-success/25 motion-reduce:hidden" />
          <span className="absolute -inset-2.5 rounded-full border-2 border-success/40" />
          <span className="relative flex size-24 items-center justify-center rounded-full bg-primary/15 text-3xl font-semibold text-primary">
            {ticketInitials(invite.fromName)}
          </span>
        </div>
        <p className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
          <ModeIcon className="size-3.5" />
          Incoming {video ? "video" : "voice"} call
        </p>
        <p className="mt-1.5 max-w-full truncate text-2xl font-semibold">{invite.fromName}</p>
        {invite.subject && (
          <p className="mt-1 line-clamp-2 text-sm text-muted-foreground">About “{invite.subject}”</p>
        )}

        <div className="mt-9 flex w-full items-start justify-center gap-12">
          <div className="flex flex-col items-center gap-2">
            <Button
              size="icon"
              className="size-16 rounded-full bg-danger text-white shadow-lg hover:bg-danger/90"
              onClick={reject}
              aria-label="Reject"
              title="Reject"
            >
              <PhoneOff className="size-7" />
            </Button>
            <span className="text-xs font-medium text-muted-foreground">Reject</span>
          </div>
          <div className="flex flex-col items-center gap-2">
            <Button
              size="icon"
              className="size-16 rounded-full bg-success text-white shadow-lg hover:bg-success/90"
              onClick={accept}
              aria-label="Accept"
              title="Accept"
            >
              <Phone className="size-7" />
            </Button>
            <span className="text-xs font-medium text-muted-foreground">Accept</span>
          </div>
        </div>
      </div>
    </div>
  );
}
