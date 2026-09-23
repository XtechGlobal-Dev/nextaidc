import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { useLocation } from "react-router-dom";
import { Track, type RemoteTrack } from "livekit-client";
import {
  GripHorizontal,
  Loader2,
  Maximize2,
  Mic,
  MicOff,
  Minimize2,
  PhoneOff,
  PictureInPicture2,
  Video,
  VideoOff,
  Volume2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { ticketInitials } from "@/components/tickets/ticketUi";
import { api } from "@/lib/api";
import { startRingback } from "@/lib/callTones";
import {
  callErrorMessage,
  connectToCall,
  type CallEndReason,
  type CallHandle,
  type TicketCallState,
} from "@/lib/livekit";
import { cn, formatDuration } from "@/lib/utils";
import { useCallStore } from "@/stores/useCallStore";
import { useLiveStore } from "@/stores/useLiveStore";

// The live call, mounted once in AppLayout. Full view is a centred pop-up; PiP is a
// small draggable tile that the call drops into by itself when you move to another
// page. The same media elements are kept across both, so switching never re-attaches
// tracks. The caller rings the other side once alone in the room; either side's
// hang-up (or a decline / no answer) ends it for both.

/** How long the caller waits before giving up. */
const NO_ANSWER_MS = 45_000;
/** How long a finished call stays on screen before closing itself. */
const AUTO_CLOSE_MS = 2500;
const PIP_WIDTH = 288;
const PIP_HEIGHT = 250;
const PIP_MARGIN = 16;

export function CallWindow() {
  const call = useCallStore((s) => s.call);
  if (!call) return null;
  // Keyed so a new call (even on the same ticket) starts from a clean slate.
  return <LiveCall key={call.key} />;
}

function LiveCall() {
  const call = useCallStore((s) => s.call)!;
  const view = useCallStore((s) => s.view);
  const setView = useCallStore((s) => s.setView);
  const endCall = useCallStore((s) => s.end);
  const { ticketId, subject, otherName, mode, perspective, incoming } = call;

  const [state, setState] = useState<TicketCallState>("connecting");
  const [endMessage, setEndMessage] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [muted, setMuted] = useState(false);
  const [cameraOn, setCameraOn] = useState(false);
  const [remoteCount, setRemoteCount] = useState(0);
  const [hasRemoteVideo, setHasRemoteVideo] = useState(false);
  const [audioBlocked, setAudioBlocked] = useState(false);
  const [seconds, setSeconds] = useState(0);
  const [pos, setPos] = useState(() => defaultPipPosition());

  const handleRef = useRef<CallHandle | null>(null);
  const stopToneRef = useRef<(() => void) | null>(null);
  const noAnswerRef = useRef<number>(0);
  const remoteEverRef = useRef(false);
  const finishedRef = useRef(false);
  const openedAtRef = useRef(Date.now());
  const remoteVideoRef = useRef<HTMLVideoElement>(null);
  const localVideoRef = useRef<HTMLVideoElement>(null);
  const audioHostRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ dx: number; dy: number } | null>(null);

  const sideApi = perspective === "staff" ? api.admin.tickets : api.tickets;
  const ended = useLiveStore((s) => s.callEnded);

  function stopRinging() {
    stopToneRef.current?.();
    stopToneRef.current = null;
    window.clearTimeout(noAnswerRef.current);
  }

  /** Ends the call on this side. `tell` also informs the other side. */
  function finish(message: string, tell?: CallEndReason, error = false) {
    if (finishedRef.current) return;
    finishedRef.current = true;
    console.info("[call] finished:", message, tell ? `(told other side: ${tell})` : "");
    stopRinging();
    if (tell) void sideApi.callEnd(ticketId, tell).catch(() => {});
    const handle = handleRef.current;
    handleRef.current = null;
    void handle?.leave();
    setEndMessage(message);
    setFailed(error);
    setState("ended");
  }

  useEffect(() => {
    let cancelled = false;

    const attachRemote = (track: RemoteTrack) => {
      if (track.kind === Track.Kind.Video) {
        if (remoteVideoRef.current) track.attach(remoteVideoRef.current);
        setHasRemoteVideo(true);
      } else {
        audioHostRef.current?.appendChild(track.attach());
      }
    };

    // Deferred a tick: React's dev-mode double-run of effects would otherwise start two
    // joins with the same identity, and the first one's cancel-leave kicks the second.
    const kickoff = window.setTimeout(async () => {
      try {
        const grant = await sideApi.callToken(ticketId, mode);
        if (cancelled) return;
        const handle = await connectToCall(grant, {
          onState: (s) => {
            if (cancelled || finishedRef.current) return;
            if (s === "ended") finish("Connection lost");
            else setState(s);
          },
          onRemoteTrack: attachRemote,
          onRemoteTrackRemoved: (track) => {
            track.detach().forEach((el) => el.remove());
            if (track.kind === Track.Kind.Video) setHasRemoteVideo(false);
          },
          onRemoteCount: (count) => {
            if (cancelled) return;
            setRemoteCount(count);
            if (count > 0) {
              // The clock starts when the other side is actually there, not while ringing.
              if (!remoteEverRef.current) setSeconds(0);
              remoteEverRef.current = true;
              stopRinging();
            } else if (remoteEverRef.current) {
              finish(`${otherName} left the call`);
            }
          },
          onAudioBlocked: setAudioBlocked,
        });
        if (cancelled) {
          void handle.leave();
          return;
        }
        handleRef.current = handle;
        if (mode === "video") {
          setCameraOn(true);
          attachLocalCamera(handle, localVideoRef.current);
        }
        // Alone in the room and placing the call: ring the other side and wait.
        if (!incoming && handle.room.remoteParticipants.size === 0) {
          void sideApi.callRing(ticketId, mode).catch(() => {});
          stopToneRef.current = startRingback();
          noAnswerRef.current = window.setTimeout(() => finish("No answer", "missed"), NO_ANSWER_MS);
        }
      } catch (e) {
        if (cancelled) return;
        finish(callErrorMessage(e), undefined, true);
      }
    }, 0);

    return () => {
      cancelled = true;
      window.clearTimeout(kickoff);
      stopRinging();
      const handle = handleRef.current;
      handleRef.current = null;
      void handle?.leave();
    };
    // One connection per mounted call — the component is keyed per call.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The other side hung up, declined, or gave up ringing.
  useEffect(() => {
    if (!ended || ended.ticketId !== ticketId || ended.at < openedAtRef.current) return;
    if (state !== "connecting" && state !== "active") return;
    const message =
      ended.reason === "declined"
        ? `${otherName} declined the call`
        : ended.reason === "missed"
          ? "No answer"
          : `${otherName} ended the call`;
    finish(message);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ended, ticketId, state]);

  useEffect(() => {
    if (state !== "active") return;
    const id = window.setInterval(() => setSeconds((s) => s + 1), 1000);
    return () => window.clearInterval(id);
  }, [state]);

  // A call that ended on its own closes itself; an error stays so it can be read.
  useEffect(() => {
    if (state !== "ended" || failed) return;
    const id = window.setTimeout(endCall, AUTO_CLOSE_MS);
    return () => window.clearTimeout(id);
  }, [state, failed, endCall]);

  // Full screen: the `max` view lays the window out edge to edge, and the browser's own
  // full-screen mode is asked for on top when it exists (Esc leaves it, and the window
  // follows back to the pop-up). On browsers without it, `max` alone still fills the tab.
  const rootRef = useRef<HTMLDivElement>(null);
  const leaveBrowserFullscreen = () => {
    if (typeof document === "undefined" || !document.fullscreenElement) return;
    document.exitFullscreen?.().catch(() => {});
  };
  function goMax() {
    setView("max");
    rootRef.current?.requestFullscreen?.().catch(() => {});
  }
  function goFull() {
    leaveBrowserFullscreen();
    setView("full");
  }
  function goPip() {
    leaveBrowserFullscreen();
    setView("pip");
  }
  useEffect(() => {
    const onChange = () => {
      if (!document.fullscreenElement && useCallStore.getState().view === "max") setView("full");
    };
    document.addEventListener("fullscreenchange", onChange);
    return () => {
      document.removeEventListener("fullscreenchange", onChange);
      leaveBrowserFullscreen();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Leaving the page the call was started on drops it into PiP.
  const { pathname } = useLocation();
  const startPathRef = useRef(pathname);
  useEffect(() => {
    if (pathname !== startPathRef.current && view !== "pip" && state !== "ended") {
      goPip();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pathname]);

  // Keep the PiP tile on screen when the window shrinks.
  useEffect(() => {
    const onResize = () => setPos((p) => clampPip(p));
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  // The pop-up sits over the conversation it belongs to, edge to edge — while you're on
  // that ticket the chat box IS the call. The thread marks its message area with
  // data-call-anchor; this follows it through resizes and scrolling, and waits for it
  // when the thread mounts after the call started (opened from another page, lazy
  // route). Off that page the pop-up centres itself instead.
  const [anchor, setAnchor] = useState<AnchorRect | null>(null);
  useEffect(() => {
    if (view !== "full") {
      setAnchor(null);
      return;
    }
    let el: HTMLElement | null = null;
    let sizer: ResizeObserver | null = null;
    const measure = () => {
      if (!el) return;
      const r = el.getBoundingClientRect();
      const next = { left: r.left, top: r.top, width: r.width, height: r.height };
      setAnchor((prev) => (prev && sameRect(prev, next) ? prev : next));
    };
    const find = () => {
      const found = document.querySelector<HTMLElement>(
        `[data-call-anchor="${CSS.escape(ticketId)}"]`,
      );
      if (found === el) return;
      sizer?.disconnect();
      sizer = null;
      el = found;
      if (!el) {
        setAnchor(null);
        return;
      }
      measure();
      sizer = new ResizeObserver(measure);
      sizer.observe(el);
    };
    find();
    const watcher = new MutationObserver(find);
    watcher.observe(document.body, { childList: true, subtree: true });
    window.addEventListener("resize", measure);
    window.addEventListener("scroll", measure, true);
    return () => {
      sizer?.disconnect();
      watcher.disconnect();
      window.removeEventListener("resize", measure);
      window.removeEventListener("scroll", measure, true);
    };
  }, [view, ticketId]);

  function onDragStart(e: ReactPointerEvent<HTMLDivElement>) {
    if (view !== "pip") return;
    dragRef.current = { dx: e.clientX - pos.x, dy: e.clientY - pos.y };
    e.currentTarget.setPointerCapture(e.pointerId);
  }
  function onDrag(e: ReactPointerEvent<HTMLDivElement>) {
    const d = dragRef.current;
    if (!d) return;
    setPos(clampPip({ x: e.clientX - d.dx, y: e.clientY - d.dy }));
  }
  function onDragEnd(e: ReactPointerEvent<HTMLDivElement>) {
    dragRef.current = null;
    e.currentTarget.releasePointerCapture(e.pointerId);
  }

  async function toggleMute() {
    const next = !muted;
    setMuted(next);
    await handleRef.current?.setMuted(next).catch(() => setMuted(!next));
  }

  async function toggleCamera() {
    const handle = handleRef.current;
    if (!handle) return;
    const next = !cameraOn;
    setCameraOn(next);
    try {
      await handle.setCamera(next);
      if (next) attachLocalCamera(handle, localVideoRef.current);
    } catch (e) {
      setCameraOn(!next);
      setEndMessage(callErrorMessage(e));
    }
  }

  function hangUp() {
    if (state === "connecting" || state === "active") finish("Call ended", "hangup");
    endCall();
  }

  const pip = view === "pip";
  const max = view === "max";
  // The pop-up over its own conversation: fills that box like full screen fills the screen.
  const anchored = view === "full" && anchor !== null;
  const fill = max || anchored;
  const ringing = state === "active" && remoteCount === 0;
  const status =
    state === "connecting"
      ? "Connecting…"
      : state === "active"
        ? ringing
          ? incoming
            ? "Joining…"
            : `Calling ${otherName}…`
          : "Connected"
        : (endMessage ?? "Call ended");
  const title = mode === "video" ? "Video call" : "Voice call";

  return (
    <div
      ref={rootRef}
      className={cn(
        // Above the tour (997), quick-setup (1001) and dialogs (1200): a call must stay reachable.
        "fixed z-[1300]",
        // The pop-up floats over the page without dimming it: the rest of the page stays readable
        // and clickable behind it (like the small window), so the wrapper lets clicks through and
        // only the card itself catches them. Full screen is the one view that takes the whole screen.
        view === "full" && "pointer-events-none flex",
        view === "full" && !anchored && "inset-0 items-center justify-center p-4",
        max && "inset-0 flex bg-black",
      )}
      style={
        pip
          ? { left: pos.x, top: pos.y, width: PIP_WIDTH }
          : anchored
            ? { left: anchor.left, top: anchor.top, width: anchor.width, height: anchor.height }
            : undefined
      }
      role="dialog"
      aria-label={`${title} with ${otherName}`}
    >
      <div
        className={cn(
          "flex w-full flex-col overflow-hidden bg-background",
          view === "full" && "pointer-events-auto",
          // Over its own conversation it IS the chat box: header where the "Conversation" bar was,
          // controls where the composer was — no corners, border or shadow of its own.
          view === "full" && (anchored ? "h-full" : "max-w-lg rounded-2xl border border-border shadow-2xl"),
          max && "h-full",
          pip && "rounded-2xl border border-border shadow-2xl",
        )}
      >
        {/* Header — the drag handle in PiP. */}
        <div
          className={cn(
            "flex items-center gap-2 border-b border-border px-3 py-2",
            pip && "cursor-grab touch-none select-none active:cursor-grabbing",
          )}
          onPointerDown={onDragStart}
          onPointerMove={onDrag}
          onPointerUp={onDragEnd}
          onPointerCancel={onDragEnd}
        >
          {pip && <GripHorizontal className="size-4 shrink-0 text-muted-foreground" />}
          <div className="min-w-0 flex-1">
            <p className={cn("truncate font-semibold", pip ? "text-xs" : "text-base")}>
              {pip ? otherName : title}
            </p>
            {!pip && <p className="truncate text-xs text-muted-foreground">{subject}</p>}
            {pip && (
              <p className="truncate text-[11px] text-muted-foreground">
                {state === "active" && remoteCount > 0 ? formatDuration(seconds) : status}
              </p>
            )}
          </div>
          {/* Two controls in every view: full screen (or back out of it) and the small window
              (or back out of it), so neither layout is more than one tap away. */}
          <Button
            variant="ghost"
            size="icon"
            className="size-8 shrink-0 text-muted-foreground"
            onPointerDown={(e) => e.stopPropagation()}
            onClick={max ? goFull : goMax}
            aria-label={max ? "Exit full screen" : "Full screen"}
            title={max ? "Exit full screen" : "Full screen"}
          >
            {max ? <Minimize2 className="size-4" /> : <Maximize2 className="size-4" />}
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="size-8 shrink-0 text-muted-foreground"
            onPointerDown={(e) => e.stopPropagation()}
            onClick={pip ? goFull : goPip}
            aria-label={pip ? "Expand call" : "Minimise call"}
            title={pip ? "Back to the pop-up" : "Minimise to a small window"}
          >
            <PictureInPicture2 className={cn("size-4", pip && "rotate-180")} />
          </Button>
        </div>

        {/* Stage — the same elements in both views, so tracks stay attached. */}
        <div
          className={cn("relative w-full overflow-hidden bg-slate-950 text-white", fill && "min-h-0 flex-1")}
          style={{
            height: pip ? PIP_HEIGHT - 96 : undefined,
            aspectRatio: view === "full" && !anchored ? "16 / 9" : undefined,
          }}
        >
          <video
            ref={remoteVideoRef}
            autoPlay
            playsInline
            className={cn("size-full object-cover", !hasRemoteVideo && "hidden")}
          />
          {!hasRemoteVideo && (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-2">
              <div className="relative">
                {(state === "connecting" || ringing) && (
                  <span className="absolute inset-0 animate-ping rounded-full bg-white/20 motion-reduce:hidden" />
                )}
                <div
                  className={cn(
                    "relative flex items-center justify-center rounded-full bg-white/10 font-semibold",
                    pip ? "size-12 text-base" : "size-20 text-2xl",
                  )}
                >
                  {state === "connecting" ? (
                    <Loader2 className={cn("animate-spin", pip ? "size-5" : "size-7")} />
                  ) : (
                    ticketInitials(otherName)
                  )}
                </div>
              </div>
              {!pip && (
                <>
                  <p className="text-sm font-medium">{otherName}</p>
                  <p className={cn("text-xs", failed ? "text-red-300" : "text-white/70")}>{status}</p>
                </>
              )}
            </div>
          )}
          <video
            ref={localVideoRef}
            autoPlay
            muted
            playsInline
            className={cn(
              "absolute bottom-2 right-2 rounded-lg bg-black/60 object-cover shadow-lg",
              pip ? "h-14 w-20" : fill ? "bottom-4 right-4 h-36 w-48" : "h-24 w-32",
              !cameraOn && "hidden",
            )}
          />
          <div ref={audioHostRef} className="hidden" />
          {!pip && state === "active" && remoteCount > 0 && (
            <span className="absolute left-3 top-3 rounded-full bg-black/50 px-2 py-0.5 text-xs tabular-nums">
              {formatDuration(seconds)}
            </span>
          )}
        </div>

        {audioBlocked && state === "active" && (
          <Button
            variant="outline"
            className="m-3 gap-2"
            onClick={() => void handleRef.current?.startAudio().then(() => setAudioBlocked(false))}
          >
            <Volume2 className="size-4" /> Tap to hear the call
          </Button>
        )}

        {/* Controls. */}
        <div className={cn("flex items-center justify-center", pip ? "gap-2 p-2" : "gap-3 p-4")}>
          {state === "ended" ? (
            <Button variant="outline" size={pip ? "sm" : "md"} onClick={endCall}>
              Close
            </Button>
          ) : (
            <>
              <Button
                variant="outline"
                size="icon"
                className={cn("rounded-full", pip ? "size-9" : "size-12", muted && "bg-muted")}
                onClick={() => void toggleMute()}
                disabled={state !== "active"}
                aria-pressed={muted}
                aria-label={muted ? "Unmute" : "Mute"}
                title={muted ? "Unmute" : "Mute"}
              >
                {muted ? <MicOff className={pip ? "size-4" : "size-5"} /> : <Mic className={pip ? "size-4" : "size-5"} />}
              </Button>
              <Button
                variant="outline"
                size="icon"
                className={cn("rounded-full", pip ? "size-9" : "size-12", !cameraOn && "bg-muted")}
                onClick={() => void toggleCamera()}
                disabled={state !== "active"}
                aria-pressed={cameraOn}
                aria-label={cameraOn ? "Turn camera off" : "Turn camera on"}
                title={cameraOn ? "Turn camera off" : "Turn camera on"}
              >
                {cameraOn ? (
                  <Video className={pip ? "size-4" : "size-5"} />
                ) : (
                  <VideoOff className={pip ? "size-4" : "size-5"} />
                )}
              </Button>
              <Button
                size="icon"
                className={cn("rounded-full bg-danger text-white hover:bg-danger/90", pip ? "size-9" : "size-12")}
                onClick={hangUp}
                aria-label="Hang up"
                title="Hang up"
              >
                <PhoneOff className={pip ? "size-4" : "size-5"} />
              </Button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

/** Where the conversation box is on screen — the pop-up copies it exactly. */
interface AnchorRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

function sameRect(a: AnchorRect, b: AnchorRect): boolean {
  return a.left === b.left && a.top === b.top && a.width === b.width && a.height === b.height;
}

function attachLocalCamera(handle: CallHandle, el: HTMLVideoElement | null) {
  const track = handle.room.localParticipant.getTrackPublication(Track.Source.Camera)?.videoTrack;
  if (track && el) track.attach(el);
}

function defaultPipPosition() {
  return clampPip({
    x: window.innerWidth - PIP_WIDTH - PIP_MARGIN,
    // Above the mobile bottom nav.
    y: window.innerHeight - PIP_HEIGHT - PIP_MARGIN - 72,
  });
}

function clampPip(p: { x: number; y: number }) {
  return {
    x: Math.min(Math.max(PIP_MARGIN, p.x), Math.max(PIP_MARGIN, window.innerWidth - PIP_WIDTH - PIP_MARGIN)),
    y: Math.min(Math.max(PIP_MARGIN, p.y), Math.max(PIP_MARGIN, window.innerHeight - PIP_HEIGHT - PIP_MARGIN)),
  };
}
