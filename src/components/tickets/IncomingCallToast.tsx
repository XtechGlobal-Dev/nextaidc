import { useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { Phone, PhoneOff, Video } from "lucide-react";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";
import { startRingtone } from "@/lib/callTones";
import { adminHref } from "@/lib/onboardingRoute";
import { useAuthStore } from "@/stores/useAuthStore";
import { useLiveStore } from "@/stores/useLiveStore";

// The ring. Mounted once in AppLayout so a call reaches you on any page; answering
// opens the ticket with ?answer=<mode>, which the ticket page turns into a joined call.

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

  if (!invite || !live) return null;

  const sideApi = invite.to === "staff" ? api.admin.tickets : api.tickets;
  const Icon = invite.mode === "video" ? Video : Phone;

  function decline() {
    if (!invite) return;
    void sideApi.callEnd(invite.ticketId, "declined").catch(() => {});
    clear(invite.ticketId);
  }

  function answer() {
    if (!invite) return;
    clear(invite.ticketId);
    const link = `${invite.link}&answer=${invite.mode}`;
    navigate(link.startsWith("/dashboard/admin") ? adminHref(link, role) : link);
  }

  return (
    <div
      role="alertdialog"
      aria-label={`Incoming ${invite.mode} call from ${invite.fromName}`}
      className="fixed inset-x-4 bottom-[calc(4.5rem+env(safe-area-inset-bottom))] z-[1310] mx-auto flex max-w-sm items-center gap-3 rounded-2xl border border-border bg-background p-3 shadow-xl md:inset-x-auto md:bottom-6 md:right-6"
    >
      <span className="relative flex size-11 shrink-0 items-center justify-center rounded-full bg-primary/15 text-primary">
        <span className="absolute inset-0 animate-ping rounded-full bg-primary/30 motion-reduce:hidden" />
        <Icon className="relative size-5" />
      </span>
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-semibold">{invite.fromName}</p>
        <p className="text-xs text-muted-foreground">
          Incoming {invite.mode === "video" ? "video" : "voice"} call
        </p>
      </div>
      <Button
        size="icon"
        variant="outline"
        className="size-10 rounded-full text-danger"
        onClick={decline}
        aria-label="Decline"
        title="Decline"
      >
        <PhoneOff className="size-4" />
      </Button>
      <Button
        size="icon"
        className="size-10 rounded-full bg-success text-white hover:bg-success/90"
        onClick={answer}
        aria-label="Answer"
        title="Answer"
      >
        <Phone className="size-4" />
      </Button>
    </div>
  );
}
