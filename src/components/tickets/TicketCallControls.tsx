import { useCallback, useEffect, useState } from "react";
import { AudioLines, Phone, Video } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ticketInitials } from "@/components/tickets/ticketUi";
import { api } from "@/lib/api";
import type { CallMode, CallStatus } from "@/lib/livekit";
import { cn } from "@/lib/utils";
import { useAuthStore } from "@/stores/useAuthStore";
import { useCallStore } from "@/stores/useCallStore";
import { useLiveStore } from "@/stores/useLiveStore";

// The call controls in a thread's header. Three looks, one spot:
//   - nobody on a call: the voice and video call buttons;
//   - a call is on and this window is in it: a live pill (waveform + who else is there) that brings
//     the call window back to the front;
//   - a call is on and this window is not in it (the other side, or the same person elsewhere):
//     the same pill plus a Join button.
// Who is on the call comes from LiveKit through the API, re-read on every call signal for the
// ticket and every few seconds while a call is live, so a crashed browser still reads as gone.

/** How often to re-read the room while a call is on. */
const LIVE_POLL_MS = 10_000;
/** LiveKit needs a moment to list a participant who just joined or left. */
const SETTLE_MS = 1_500;

interface Props {
  ticketId: string;
  subject: string;
  /** Who the other side is, for the call window's title. */
  otherName: string;
  perspective: "staff" | "requester";
  /** Whether this person may place a call right now (permission, ticket not closed). */
  canCall: boolean;
  onPlace: (mode: CallMode) => void;
}

export function TicketCallControls({ ticketId, subject, otherName, perspective, canCall, onPlace }: Props) {
  const sideApi = perspective === "staff" ? api.admin.tickets : api.tickets;
  const meId = useAuthStore((s) => s.user?.id ?? null);
  const mine = useCallStore((s) => s.call);
  const setView = useCallStore((s) => s.setView);
  const startCall = useCallStore((s) => s.start);
  const signal = useLiveStore((s) => s.callSignal);
  const onThisCall = mine?.ticketId === ticketId;

  const [status, setStatus] = useState<CallStatus | null>(null);

  const refresh = useCallback(() => {
    sideApi
      .callStatus(ticketId)
      .then(setStatus)
      .catch(() => {
        /* the header keeps its last reading; the next signal or poll corrects it */
      });
  }, [sideApi, ticketId]);

  // On open, on every call signal for this ticket, and shortly after this window joins or leaves.
  useEffect(() => {
    refresh();
  }, [refresh]);
  useEffect(() => {
    if (signal?.ticketId === ticketId) {
      refresh();
      const id = window.setTimeout(refresh, SETTLE_MS);
      return () => window.clearTimeout(id);
    }
  }, [signal, ticketId, refresh]);
  useEffect(() => {
    const id = window.setTimeout(refresh, SETTLE_MS);
    return () => window.clearTimeout(id);
  }, [onThisCall, refresh]);
  useEffect(() => {
    if (!status?.live && !onThisCall) return;
    const id = window.setInterval(refresh, LIVE_POLL_MS);
    return () => window.clearInterval(id);
  }, [status?.live, onThisCall, refresh]);

  const live = Boolean(status?.live) || onThisCall;

  if (!live) {
    if (!canCall) return null;
    return (
      <>
        <Button
          variant="ghost"
          size="icon"
          className="text-muted-foreground hover:bg-muted hover:text-foreground"
          aria-label="Start a voice call"
          title="Voice call"
          onClick={() => onPlace("audio")}
        >
          <Phone className="size-4" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="text-muted-foreground hover:bg-muted hover:text-foreground"
          aria-label="Start a video call"
          title="Video call"
          onClick={() => onPlace("video")}
        >
          <Video className="size-4" />
        </Button>
      </>
    );
  }

  const others = (status?.participants ?? []).filter((p) => p.userId !== meId);
  const mode: CallMode = status?.mode ?? mine?.mode ?? "audio";

  function join() {
    startCall({ ticketId, subject, otherName, mode, perspective, incoming: true });
    // Same as picking up the ring: this account's other windows stop ringing.
    void sideApi.callAnswered(ticketId).catch(() => {});
    useLiveStore.getState().clearCallInvite(ticketId);
  }

  return (
    <div
      className="flex items-center gap-1 rounded-full bg-foreground p-1 text-background"
      role="status"
      aria-label={onThisCall ? "You are on this call" : `A ${mode} call is in progress`}
    >
      <button
        type="button"
        className={cn(
          "flex items-center gap-1.5 rounded-full py-1 pl-2 pr-2 text-xs font-medium",
          onThisCall && "hover:bg-background/10",
        )}
        onClick={onThisCall ? () => setView("full") : undefined}
        title={onThisCall ? "Back to the call" : `${mode === "video" ? "Video" : "Voice"} call in progress`}
        disabled={!onThisCall}
      >
        <AudioLines className="size-4 animate-pulse text-success motion-reduce:animate-none" />
        {others.length > 0 ? (
          <span className="flex -space-x-1.5">
            {others.slice(0, 3).map((p) => (
              <span
                key={p.userId}
                className="grid size-6 place-items-center rounded-full bg-primary text-[10px] font-semibold text-primary-foreground ring-2 ring-foreground"
                title={p.name}
              >
                {ticketInitials(p.name)}
              </span>
            ))}
          </span>
        ) : (
          <span className="pr-1">{onThisCall ? "On call" : "Call"}</span>
        )}
      </button>
      {!onThisCall && (
        <Button
          size="sm"
          className="h-7 rounded-full bg-success px-3 text-xs text-white hover:bg-success/90"
          onClick={join}
          aria-label="Join call"
        >
          Join
        </Button>
      )}
    </div>
  );
}
