import { useEffect } from "react";
import { AudioLines } from "lucide-react";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";
import { useCallStore } from "@/stores/useCallStore";
import { useLiveStore } from "@/stores/useLiveStore";

// "Join" in the top bar: for the call this account was last rung for, from any page, while it is
// still going on and this window is not in it — the ring was rejected by mistake, expired while
// away, or was picked up in another window. Joining is the same as picking up the ring. The pill
// keeps checking the room and leaves by itself once the call is over.

/** How often to re-check whether the call is still on. */
const POLL_MS = 5_000;
/** A fresh ring is trusted for this long before the room is required to have someone in it — the
 *  caller rings before they have finished connecting. */
const RING_GRACE_MS = 20_000;

export function NavbarJoinCall({ className }: { className?: string }) {
  const joinable = useLiveStore((s) => s.joinable);
  const clearJoinable = useLiveStore((s) => s.clearJoinable);
  const mine = useCallStore((s) => s.call);
  const live = useCallStore((s) => s.live);
  const startCall = useCallStore((s) => s.start);

  const ticketId = joinable?.ticketId;
  const to = joinable?.to;
  const at = joinable?.at ?? 0;

  useEffect(() => {
    if (!ticketId || !to) return;
    const sideApi = to === "staff" ? api.admin.tickets : api.tickets;
    let stopped = false;
    const check = () => {
      sideApi
        .callStatus(ticketId)
        .then((s) => {
          if (stopped) return;
          if (!s.live && Date.now() - at > RING_GRACE_MS) clearJoinable(ticketId);
        })
        .catch(() => {
          /* keep offering; the next check or the hang-up signal decides */
        });
    };
    check();
    const id = window.setInterval(check, POLL_MS);
    return () => {
      stopped = true;
      window.clearInterval(id);
    };
  }, [ticketId, to, at, clearJoinable]);

  if (!joinable) return null;
  // This window is on that call already: the call window itself is the control.
  if (live && mine?.ticketId === joinable.ticketId) return null;

  function join() {
    if (!joinable) return;
    const sideApi = joinable.to === "staff" ? api.admin.tickets : api.tickets;
    startCall({
      ticketId: joinable.ticketId,
      subject: joinable.subject ?? "",
      otherName: joinable.fromName,
      mode: joinable.mode,
      perspective: joinable.to,
      incoming: true,
    });
    // Same as picking up the ring: this account's other windows stop ringing.
    void sideApi.callAnswered(joinable.ticketId).catch(() => {});
    useLiveStore.getState().clearCallInvite(joinable.ticketId);
  }

  return (
    <button
      type="button"
      onClick={join}
      className={cn(
        "flex h-10 shrink-0 items-center gap-2 rounded-xl bg-success px-3.5 text-sm font-medium text-white shadow-sm transition-colors hover:bg-success/90",
        className,
      )}
      aria-label={`Join the ${joinable.mode} call with ${joinable.fromName}`}
      title={joinable.subject ? `About “${joinable.subject}”` : undefined}
    >
      <AudioLines className="size-4 animate-pulse motion-reduce:animate-none" />
      <span>Join call</span>
      <span className="hidden max-w-32 truncate font-normal text-white/80 lg:inline">· {joinable.fromName}</span>
    </button>
  );
}
