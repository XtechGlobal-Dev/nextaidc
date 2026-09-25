import {
  Fragment,
  forwardRef,
  useCallback,
  useEffect,
  useRef,
  useState,
  type ComponentType,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import { useLocation } from "react-router-dom";
import { Track, type RemoteTrack } from "livekit-client";
import {
  Check,
  ChevronDown,
  Columns2,
  GripHorizontal,
  LayoutGrid,
  LayoutTemplate,
  Loader2,
  Maximize2,
  MessageSquare,
  Mic,
  MicOff,
  Minimize2,
  Monitor,
  MonitorOff,
  MonitorUp,
  MousePointer2,
  MousePointerClick,
  Pause,
  PhoneOff,
  PictureInPicture2,
  Play,
  User,
  Users,
  Video,
  VideoOff,
  Volume2,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { PointerCursor, videoContentRect, type PointerState } from "@/components/tickets/PointerCursor";
import { ScreenShareBar, type ShareAudio } from "@/components/tickets/ScreenShareBar";
import { ticketInitials } from "@/components/tickets/ticketUi";
import { api } from "@/lib/api";
import { playCallEnd, startHoldTone, startRingback } from "@/lib/callTones";
import {
  callErrorMessage,
  connectToCall,
  disconnectMessage,
  isPickerCancelled,
  type CallEndReason,
  type CallHandle,
  type CallLayout,
  type CallSignal,
  type RosterEntry,
  type ShareSurface,
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
/** How long the other side may be gone before the call counts as over. LiveKit drops their
 *  session the moment the same account joins from another tab or browser, and the newcomer
 *  is in within a second or two; a real hang-up says so itself (call-ended) and ends this at once. */
const REJOIN_GRACE_MS = 8_000;
/** How long a finished call stays on screen before closing itself. */
const AUTO_CLOSE_MS = 2500;
const PIP_WIDTH = 288;
const PIP_HEIGHT = 250;
const PIP_MARGIN = 16;
/** Menus open over the call window itself (z-1300), so the default z-50 would put them under it. */
const MENU_Z = "z-[1320]";
/** Pointer positions go out at most this often; the newest is all the other side needs. */
const POINTER_INTERVAL_MS = 33;
/** A shared pointer that stops moving fades out after this. */
const POINTER_IDLE_MS = 4000;
/** How long a control request waits for an answer before the button resets. */
const CONTROL_ASK_MS = 30_000;

type Panel = "chat" | "people" | null;

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
  const chatSlot = useCallStore((s) => s.chatSlot);
  const setChatHost = useCallStore((s) => s.setChatHost);
  const { ticketId, subject, otherName, mode, perspective, incoming } = call;

  const [state, setState] = useState<TicketCallState>("connecting");
  const [endMessage, setEndMessage] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [muted, setMuted] = useState(false);
  const [cameraOn, setCameraOn] = useState(false);
  const [remoteCount, setRemoteCount] = useState(0);
  const [rejoining, setRejoining] = useState(false);
  const [hasRemoteVideo, setHasRemoteVideo] = useState(false);
  const [audioBlocked, setAudioBlocked] = useState(false);
  /** Something worth knowing mid-call (the camera would not start, say) — the call goes on. */
  const [notice, setNotice] = useState<string | null>(null);
  const [seconds, setSeconds] = useState(0);
  const [pos, setPos] = useState(() => defaultPipPosition());
  /** I put them on hold. */
  const [held, setHeld] = useState(false);
  /** They put me on hold. */
  const [heldBy, setHeldBy] = useState(false);
  const [sharing, setSharing] = useState(false);
  const [shareAudio, setShareAudio] = useState<ShareAudio>("none");
  const [optimized, setOptimized] = useState(false);
  const [hasRemoteScreen, setHasRemoteScreen] = useState(false);
  const [panel, setPanel] = useState<Panel>(null);
  const [layout, setLayout] = useState<CallLayout>("speaker");
  const [roster, setRoster] = useState<RosterEntry[]>([]);
  const [shareSurface, setShareSurface] = useState<ShareSurface>(undefined);
  // Pointer control over the shared screen. Sharer side: the viewer asked / has it.
  // Viewer side: waiting for an answer / has it.
  const [controlRequest, setControlRequest] = useState(false);
  const [controlAsking, setControlAsking] = useState(false);
  const [controlGranted, setControlGranted] = useState(false);
  /** The viewer's pointer as the sharer sees it. */
  const [remotePointer, setRemotePointer] = useState<PointerState | null>(null);
  /** The viewer's own pointer, drawn where it will show up on the other side. */
  const [localPointer, setLocalPointer] = useState<PointerState | null>(null);

  const handleRef = useRef<CallHandle | null>(null);
  const controlGrantedRef = useRef(false);
  const pointerSentRef = useRef(0);
  const askTimerRef = useRef<number>(0);
  const stopToneRef = useRef<(() => void) | null>(null);
  const noAnswerRef = useRef<number>(0);
  const goneRef = useRef<number>(0);
  const remoteEverRef = useRef(false);
  const finishedRef = useRef(false);
  const cancelledRef = useRef(false);
  const openedAtRef = useRef(Date.now());
  const remoteVideoRef = useRef<HTMLVideoElement>(null);
  const localVideoRef = useRef<HTMLVideoElement>(null);
  const screenVideoRef = useRef<HTMLVideoElement>(null);
  const remoteScreenRef = useRef<RemoteTrack | null>(null);
  const sharingRef = useRef(false);
  const preHoldRef = useRef<{ muted: boolean; cameraOn: boolean } | null>(null);
  const audioHostRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ dx: number; dy: number } | null>(null);

  const sideApi = perspective === "staff" ? api.admin.tickets : api.tickets;
  const ended = useLiveStore((s) => s.callEnded);

  function stopRinging() {
    stopToneRef.current?.();
    stopToneRef.current = null;
    window.clearTimeout(noAnswerRef.current);
  }

  /** Rings the other side. Best-effort; `reached` says whether anyone has the app open. */
  function ring() {
    void sideApi
      .callRing(ticketId, mode)
      .then((r) => {
        // Nobody has the app open: the ring landed nowhere, only the bell got it. Say so
        // instead of ringing into silence for 45 seconds.
        if (!cancelledRef.current && !finishedRef.current && r.reached === 0) {
          setNotice(`${otherName} isn't online right now — they've been sent a notification.`);
        }
      })
      .catch(() => {});
  }

  /** Ends the call on this side. `tell` also informs the other side. */
  function finish(message: string, tell?: CallEndReason, error = false) {
    if (finishedRef.current) return;
    finishedRef.current = true;
    console.info("[call] finished:", message, tell ? `(told other side: ${tell})` : "");
    useCallStore.getState().markEnded();
    stopRinging();
    playCallEnd();
    window.clearTimeout(goneRef.current);
    if (tell) void sideApi.callEnd(ticketId, tell).catch(() => {});
    const handle = handleRef.current;
    handleRef.current = null;
    void handle?.leave();
    setEndMessage(message);
    setFailed(error);
    setState("ended");
  }

  /** Points the screen element at whichever share is on: theirs first, else our own preview. */
  function refreshScreen() {
    const el = screenVideoRef.current;
    if (!el) return;
    const track =
      remoteScreenRef.current ??
      handleRef.current?.room.localParticipant.getTrackPublication(Track.Source.ScreenShare)?.videoTrack;
    if (track) track.attach(el);
    else el.srcObject = null;
  }

  /** Nobody points on anybody's screen any more, whichever side we are. */
  function resetControl() {
    controlGrantedRef.current = false;
    window.clearTimeout(askTimerRef.current);
    setControlGranted(false);
    setControlAsking(false);
    setControlRequest(false);
    setRemotePointer(null);
    setLocalPointer(null);
  }

  function onControlSignal(action: Extract<CallSignal, { t: "control" }>["action"]) {
    switch (action) {
      case "request":
        setControlRequest(true);
        break;
      case "grant":
        window.clearTimeout(askTimerRef.current);
        setControlAsking(false);
        controlGrantedRef.current = true;
        setControlGranted(true);
        setNotice(`${otherName} let you point on their screen — move your mouse over it.`);
        break;
      case "deny":
        window.clearTimeout(askTimerRef.current);
        setControlAsking(false);
        setNotice(`${otherName} didn't allow pointing this time.`);
        break;
      case "revoke":
        if (controlGrantedRef.current) setNotice(`${otherName} took back control.`);
        resetControl();
        break;
      case "release":
        resetControl();
        break;
    }
  }

  /** Our share is over, however it was stopped (our button or the browser's own bar). */
  function shareEnded() {
    sharingRef.current = false;
    setSharing(false);
    setShareAudio("none");
    setOptimized(false);
    setShareSurface(undefined);
    if (controlGrantedRef.current) void handleRef.current?.send({ t: "control", action: "revoke" }).catch(() => {});
    resetControl();
    refreshScreen();
    if (!remoteScreenRef.current) setLayout((l) => (isContentLayout(l) ? "speaker" : l));
  }

  useEffect(() => {
    let cancelled = false;

    const attachRemote = (track: RemoteTrack) => {
      if (track.source === Track.Source.ScreenShare) {
        remoteScreenRef.current = track;
        setHasRemoteScreen(true);
        refreshScreen();
        setLayout((l) => (isContentLayout(l) ? l : "content-people"));
        return;
      }
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
        // Placing the call: ring the other side NOW, before this browser has its camera and
        // microphone — a permission prompt or a device that will not start must never stop the
        // other side from ringing. If this side then fails to connect, the catch below tells them.
        if (!incoming) ring();
        const handle = await connectToCall(grant, {
          onState: (s) => {
            if (cancelled || finishedRef.current) return;
            setState(s);
          },
          onDisconnected: (reason) => {
            if (cancelled || finishedRef.current) return;
            finish(disconnectMessage(reason));
          },
          onRemoteTrack: attachRemote,
          onRemoteTrackRemoved: (track) => {
            if (track.source === Track.Source.ScreenShare) {
              track.detach();
              remoteScreenRef.current = null;
              setHasRemoteScreen(false);
              resetControl();
              refreshScreen();
              if (!sharingRef.current) setLayout((l) => (isContentLayout(l) ? "speaker" : l));
              return;
            }
            if (track.kind === Track.Kind.Video) {
              // Our own <video>: detach the stream but leave the element for the next track.
              track.detach();
              setHasRemoteVideo(false);
            } else {
              track.detach().forEach((el) => el.remove());
            }
          },
          onRemoteCount: (count) => {
            if (cancelled) return;
            setRemoteCount(count);
            if (count > 0) {
              window.clearTimeout(goneRef.current);
              setRejoining(false);
              // The clock starts when the other side is actually there, not while ringing.
              if (!remoteEverRef.current) setSeconds(0);
              remoteEverRef.current = true;
              stopRinging();
            } else if (remoteEverRef.current) {
              // Gone for good, or just swapping windows? Give them REJOIN_GRACE_MS to come back.
              setRejoining(true);
              setHeldBy(false);
              window.clearTimeout(goneRef.current);
              goneRef.current = window.setTimeout(
                () => finish(`${otherName} left the call`),
                REJOIN_GRACE_MS,
              );
            }
          },
          onAudioBlocked: setAudioBlocked,
          onCameraFailed: (err) => {
            if (cancelled) return;
            setNotice(callErrorMessage(err));
          },
          onRoster: (r) => {
            if (!cancelled) setRoster(r);
          },
          onSignal: (signal) => {
            if (cancelled) return;
            if (signal.t === "hold") setHeldBy(signal.on);
            else if (signal.t === "layout") setLayout(signal.value);
            else if (signal.t === "control") onControlSignal(signal.action);
            else if (signal.t === "pointer") {
              if (signal.hide) setRemotePointer(null);
              else setRemotePointer({ x: signal.x, y: signal.y, down: !!signal.down, at: Date.now() });
            }
          },
          onScreenShareEnded: () => {
            if (!cancelled) shareEnded();
          },
        });
        if (cancelled) {
          void handle.leave();
          return;
        }
        handleRef.current = handle;
        if (mode === "video" && handle.room.localParticipant.isCameraEnabled) {
          setCameraOn(true);
          attachLocalCamera(handle, localVideoRef.current);
        }
        // Placing the call and still alone: ring back and wait for an answer.
        if (!incoming && handle.room.remoteParticipants.size === 0) {
          stopToneRef.current = startRingback();
          noAnswerRef.current = window.setTimeout(() => finish("No answer", "missed"), NO_ANSWER_MS);
        }
      } catch (e) {
        if (cancelled) return;
        // Placing the call and it failed here: the other side is already ringing — stop it.
        finish(callErrorMessage(e), incoming ? undefined : "hangup", true);
      }
    }, 0);

    return () => {
      cancelled = true;
      cancelledRef.current = true;
      window.clearTimeout(kickoff);
      stopRinging();
      window.clearTimeout(goneRef.current);
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

  // On hold by the other side: a soft chime until they come back.
  useEffect(() => {
    if (!heldBy || state !== "active") return;
    return startHoldTone();
  }, [heldBy, state]);

  // A shared pointer that goes quiet fades out; a click's ring lasts a moment.
  useEffect(() => {
    if (!remotePointer) return;
    const idle = window.setTimeout(() => setRemotePointer(null), POINTER_IDLE_MS);
    const ring = remotePointer.down
      ? window.setTimeout(() => setRemotePointer((p) => (p ? { ...p, down: false } : p)), 600)
      : 0;
    return () => {
      window.clearTimeout(idle);
      window.clearTimeout(ring);
    };
  }, [remotePointer]);
  useEffect(() => {
    if (!localPointer?.down) return;
    const id = window.setTimeout(() => setLocalPointer((p) => (p ? { ...p, down: false } : p)), 600);
    return () => window.clearTimeout(id);
  }, [localPointer]);

  // A call that ended on its own closes itself; an error stays so it can be read.
  useEffect(() => {
    if (state !== "ended" || failed) return;
    const id = window.setTimeout(endCall, AUTO_CLOSE_MS);
    return () => window.clearTimeout(id);
  }, [state, failed, endCall]);

  // The Chat panel's box, handed to the page so it can render its thread and composer in there.
  const chatHostRef = useCallback((el: HTMLDivElement | null) => setChatHost(el), [setChatHost]);
  useEffect(() => () => setChatHost(null), [setChatHost]);

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
      setNotice(callErrorMessage(e));
    }
  }

  /** Hold: our mic and camera go quiet, their audio is silenced here, and they are told. Resuming
   *  puts the mic and camera back the way they were. */
  async function toggleHold() {
    const handle = handleRef.current;
    if (!handle) return;
    const next = !held;
    setHeld(next);
    try {
      if (next) {
        preHoldRef.current = { muted, cameraOn };
        setMuted(true);
        setCameraOn(false);
        await handle.setMuted(true);
        if (cameraOn) await handle.setCamera(false);
      }
      await handle.setHold(next);
      if (!next) {
        const before = preHoldRef.current;
        preHoldRef.current = null;
        if (before && !before.muted) {
          setMuted(false);
          await handle.setMuted(false);
        }
        if (before?.cameraOn) {
          setCameraOn(true);
          await handle.setCamera(true);
          attachLocalCamera(handle, localVideoRef.current);
        }
      }
    } catch (e) {
      setNotice(callErrorMessage(e));
    }
  }

  async function toggleShare() {
    const handle = handleRef.current;
    if (!handle) return;
    if (sharing) {
      await stopShare();
      return;
    }
    try {
      const { hasAudio, surface } = await handle.startScreenShare();
      sharingRef.current = true;
      setSharing(true);
      setShareAudio(hasAudio ? "on" : "none");
      setShareSurface(surface);
      setOptimized(false);
      refreshScreen();
      if (!remoteScreenRef.current) setLayout("content-people");
      // Browser full screen would sit over whatever is being shared.
      if (view === "max") goFull();
    } catch (e) {
      if (!isPickerCancelled(e)) setNotice(callErrorMessage(e));
    }
  }

  async function stopShare() {
    await handleRef.current?.stopScreenShare().catch(() => {});
    shareEnded();
  }

  async function toggleShareAudio() {
    if (shareAudio === "none") return;
    const next = shareAudio === "on" ? "off" : "on";
    setShareAudio(next);
    await handleRef.current?.setScreenShareAudio(next === "on").catch(() => setShareAudio(shareAudio));
  }

  async function toggleOptimized() {
    const next = !optimized;
    setOptimized(next);
    await handleRef.current?.setScreenShareOptimized(next).catch(() => setOptimized(!next));
  }

  /** The sharer's Layout choice is sent along so the other side sees the share the same way. */
  function chooseLayout(next: CallLayout, tell = false) {
    setLayout(next);
    if (tell) void handleRef.current?.send({ t: "layout", value: next }).catch(() => {});
  }

  function togglePanel(p: Exclude<Panel, null>) {
    setPanel((prev) => (prev === p ? null : p));
  }

  /* Pointer control — viewer side. */
  function requestControl() {
    setControlAsking(true);
    window.clearTimeout(askTimerRef.current);
    askTimerRef.current = window.setTimeout(() => setControlAsking(false), CONTROL_ASK_MS);
    void handleRef.current?.send({ t: "control", action: "request" }).catch(() => setControlAsking(false));
  }
  function releaseControl() {
    void handleRef.current?.send({ t: "control", action: "release" }).catch(() => {});
    resetControl();
  }
  /* Pointer control — sharer side. */
  function giveControl() {
    setControlRequest(false);
    controlGrantedRef.current = true;
    setControlGranted(true);
    void handleRef.current?.send({ t: "control", action: "grant" }).catch(() => {});
  }
  function denyControl() {
    setControlRequest(false);
    void handleRef.current?.send({ t: "control", action: "deny" }).catch(() => {});
  }
  function takeBackControl() {
    void handleRef.current?.send({ t: "control", action: "revoke" }).catch(() => {});
    resetControl();
  }

  /** The viewer's mouse over the shared picture, as fractions of it — null when off the picture. */
  function pointerFraction(e: ReactPointerEvent<HTMLVideoElement>) {
    const el = e.currentTarget;
    const rect = videoContentRect(el);
    if (!rect) return null;
    const box = el.getBoundingClientRect();
    const x = (e.clientX - box.left - rect.left) / rect.width;
    const y = (e.clientY - box.top - rect.top) / rect.height;
    return x < 0 || x > 1 || y < 0 || y > 1 ? null : { x, y };
  }
  const pointing = controlGranted && !sharing;
  function onScreenPointerMove(e: ReactPointerEvent<HTMLVideoElement>) {
    if (!pointing) return;
    const p = pointerFraction(e);
    if (!p) {
      setLocalPointer(null);
      return;
    }
    setLocalPointer((prev) => ({ ...p, down: prev?.down ?? false, at: Date.now() }));
    const now = Date.now();
    if (now - pointerSentRef.current < POINTER_INTERVAL_MS) return;
    pointerSentRef.current = now;
    void handleRef.current?.send({ t: "pointer", ...p }, { lossy: true }).catch(() => {});
  }
  function onScreenPointerDown(e: ReactPointerEvent<HTMLVideoElement>) {
    if (!pointing) return;
    const p = pointerFraction(e);
    if (!p) return;
    setLocalPointer({ ...p, down: true, at: Date.now() });
    void handleRef.current?.send({ t: "pointer", ...p, down: true }).catch(() => {});
  }
  function onScreenPointerLeave() {
    if (!pointing) return;
    setLocalPointer(null);
    void handleRef.current?.send({ t: "pointer", x: 0, y: 0, hide: true }).catch(() => {});
  }

  function hangUp() {
    if (state === "connecting" || state === "active") finish("Call ended", "hangup");
    endCall();
  }

  const pip = view === "pip";
  const max = view === "max";
  // The pop-up over its own conversation: fills that box like full screen fills the screen.
  const anchored = view === "full" && anchor !== null;
  const panelOpen = panel !== null && !pip;
  const fill = max || anchored;
  /** The card has a fixed height (so the stage stretches) — always when filling, and for a pop-up
   *  with a panel open, which would otherwise be as short as its video. */
  const tall = fill || panelOpen;
  const active = state === "active";
  const ringing = active && remoteCount === 0 && !rejoining;
  const chatAvailable = chatSlot === ticketId;
  const screenShown = hasRemoteScreen || sharing;
  const effectiveLayout: CallLayout = pip
    ? screenShown
      ? "content"
      : "speaker"
    : screenShown
      ? layout
      : isContentLayout(layout)
        ? "speaker"
        : layout;
  const me = roster.find((r) => r.local);
  const remote = roster.find((r) => !r.local);
  const remoteCameraOn = hasRemoteVideo && (remote?.camera ?? true);
  const status =
    state === "connecting"
      ? "Connecting…"
      : active
        ? rejoining
          ? "Reconnecting…"
          : ringing
            ? incoming
              ? "Joining…"
              : `Calling ${otherName}…`
            : held || heldBy
              ? "On hold"
              : "Connected"
        : (endMessage ?? "Call ended");
  const title = mode === "video" ? "Video call" : "Voice call";
  const thumb = fill ? "h-28 w-40" : pip ? "h-14 w-20" : "h-24 w-32";
  const smallTiles = effectiveLayout === "content-people";
  const remoteTileClass =
    effectiveLayout === "speaker"
      ? "inset-0"
      : effectiveLayout === "side"
        ? "inset-y-0 left-0 w-1/2 border-r border-white/10"
        : effectiveLayout === "content-people"
          ? cn("bottom-2 right-2 rounded-lg shadow-lg", thumb)
          : "hidden";
  const localTileClass =
    effectiveLayout === "speaker"
      ? cn("bottom-2 right-2 rounded-lg shadow-lg", fill && "bottom-4 right-4", thumb, !cameraOn && "hidden")
      : effectiveLayout === "side"
        ? "inset-y-0 right-0 w-1/2"
        : effectiveLayout === "content-people"
          ? cn("bottom-2 rounded-lg shadow-lg", thumb, fill ? "right-[11rem]" : "right-[9rem]")
          : "hidden";
  const speakersSupported = typeof HTMLMediaElement !== "undefined" && "setSinkId" in HTMLMediaElement.prototype;

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
          view === "full" &&
            (anchored
              ? "h-full"
              : cn(
                  "rounded-2xl border border-border shadow-2xl",
                  panelOpen ? "h-[min(85vh,40rem)] max-w-4xl" : "max-w-lg",
                )),
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
                {active && remoteCount > 0 && !held && !heldBy ? formatDuration(seconds) : status}
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

        <div className={cn("flex min-h-0", tall && "flex-1")}>
          <div className="flex min-h-0 min-w-0 flex-1 flex-col">
            {/* Stage — the same elements in every view and layout, so tracks stay attached. */}
            <div
              className={cn(
                "relative w-full overflow-hidden bg-slate-950 text-white",
                tall && "min-h-0 flex-1",
                sharing && "ring-2 ring-inset ring-danger",
              )}
              style={{
                height: pip ? PIP_HEIGHT - 96 : undefined,
                aspectRatio: view === "full" && !anchored && !panelOpen ? "16 / 9" : undefined,
              }}
            >
              <video
                ref={screenVideoRef}
                autoPlay
                muted
                playsInline
                onPointerMove={onScreenPointerMove}
                onPointerDown={onScreenPointerDown}
                onPointerLeave={onScreenPointerLeave}
                className={cn(
                  "absolute inset-0 size-full bg-black object-contain",
                  pointing && "cursor-crosshair",
                  !(screenShown && isContentLayout(effectiveLayout)) && "hidden",
                )}
              />
              {/* The shared pointer: theirs over our share, or our own over theirs (so we see what they see). */}
              {(() => {
                const shown = sharing ? remotePointer : pointing ? localPointer : null;
                const rect = shown && screenShown ? videoContentRect(screenVideoRef.current) : null;
                return shown && rect ? (
                  <PointerCursor
                    left={rect.left + shown.x * rect.width}
                    top={rect.top + shown.y * rect.height}
                    name={sharing ? otherName : "You"}
                    clicking={shown.down}
                  />
                ) : null;
              })()}

              <div className={cn("absolute overflow-hidden bg-slate-900", remoteTileClass)}>
                <video
                  ref={remoteVideoRef}
                  autoPlay
                  playsInline
                  className={cn("size-full object-cover", !remoteCameraOn && "hidden")}
                />
                {!remoteCameraOn && (
                  <div className="absolute inset-0 flex flex-col items-center justify-center gap-2">
                    <div className="relative">
                      {(state === "connecting" || ringing) && (
                        <span className="absolute inset-0 animate-ping rounded-full bg-white/20 motion-reduce:hidden" />
                      )}
                      <div
                        className={cn(
                          "relative flex items-center justify-center rounded-full bg-white/10 font-semibold",
                          pip || smallTiles ? "size-12 text-base" : "size-20 text-2xl",
                        )}
                      >
                        {state === "connecting" ? (
                          <Loader2 className={cn("animate-spin", pip || smallTiles ? "size-5" : "size-7")} />
                        ) : (
                          ticketInitials(otherName)
                        )}
                      </div>
                    </div>
                    {!pip && !smallTiles && (
                      <>
                        <p className="text-sm font-medium">{otherName}</p>
                        <p className={cn("text-xs", failed ? "text-red-300" : "text-white/70")}>{status}</p>
                      </>
                    )}
                  </div>
                )}
              </div>

              <div className={cn("absolute overflow-hidden bg-slate-900", localTileClass)}>
                <video
                  ref={localVideoRef}
                  autoPlay
                  muted
                  playsInline
                  className={cn("size-full object-cover", !cameraOn && "hidden")}
                />
                {!cameraOn && (
                  <div className="absolute inset-0 flex flex-col items-center justify-center gap-1">
                    <span
                      className={cn(
                        "grid place-items-center rounded-full bg-white/10 font-semibold",
                        smallTiles || pip ? "size-9 text-xs" : "size-16 text-xl",
                      )}
                    >
                      {ticketInitials(me?.name || "You")}
                    </span>
                    {!smallTiles && !pip && <p className="text-xs text-white/70">You</p>}
                  </div>
                )}
              </div>

              <div ref={audioHostRef} className="hidden" />

              {!pip && active && remoteCount > 0 && (
                <span className="absolute left-3 top-3 rounded-full bg-black/50 px-2 py-0.5 text-xs tabular-nums">
                  {formatDuration(seconds)}
                </span>
              )}

              {held && (
                <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-3 bg-black/75">
                  <Pause className={pip ? "size-5" : "size-8"} />
                  <p className={cn("font-medium", pip ? "text-xs" : "text-sm")}>{otherName} is on hold</p>
                  {!pip && (
                    <Button
                      size="sm"
                      variant="outline"
                      className="gap-1.5 border-white/30 bg-white/10 text-white hover:bg-white/20"
                      onClick={() => void toggleHold()}
                    >
                      <Play className="size-3.5" /> Resume
                    </Button>
                  )}
                </div>
              )}
              {heldBy && !held && (
                <div className="absolute inset-x-0 bottom-0 z-10 flex items-center justify-center gap-2 bg-warning/90 px-3 py-1.5 text-xs font-medium text-black">
                  <Pause className="size-3.5" /> {otherName} put you on hold
                </div>
              )}
            </div>

            {audioBlocked && active && (
              <Button
                variant="outline"
                className="m-3 gap-2"
                onClick={() => void handleRef.current?.startAudio().then(() => setAudioBlocked(false))}
              >
                <Volume2 className="size-4" /> Tap to hear the call
              </Button>
            )}
            {notice && active && (
              <p className={cn("text-center text-xs text-muted-foreground", pip ? "px-2 pt-2" : "px-4 pt-3")}>
                {notice}
              </p>
            )}
          </div>

          {panelOpen && panel === "chat" && (
            <SidePanel title="Chat" onClose={() => setPanel(null)}>
              <div ref={chatHostRef} className="flex min-h-0 flex-1 flex-col" />
              {!chatAvailable && (
                <p className="p-4 text-center text-xs text-muted-foreground">
                  Open this request to chat during the call.
                </p>
              )}
            </SidePanel>
          )}
          {panelOpen && panel === "people" && (
            <SidePanel title={`People (${roster.length})`} onClose={() => setPanel(null)}>
              <PeopleList roster={roster} />
            </SidePanel>
          )}
        </div>

        {/* Controls. */}
        {state === "ended" ? (
          <div className={cn("flex items-center justify-center", pip ? "p-2" : "p-4")}>
            <Button variant="outline" size={pip ? "sm" : "md"} onClick={endCall}>
              Close
            </Button>
          </div>
        ) : pip ? (
          <div className="flex items-center justify-center gap-2 p-2">
            <Button
              variant="outline"
              size="icon"
              className={cn("size-9 rounded-full", muted && "bg-muted")}
              onClick={() => void toggleMute()}
              disabled={!active || held}
              aria-pressed={muted}
              aria-label={muted ? "Unmute" : "Mute"}
              title={muted ? "Unmute" : "Mute"}
            >
              {muted ? <MicOff className="size-4" /> : <Mic className="size-4" />}
            </Button>
            <Button
              variant="outline"
              size="icon"
              className={cn("size-9 rounded-full", !cameraOn && "bg-muted")}
              onClick={() => void toggleCamera()}
              disabled={!active || held}
              aria-pressed={cameraOn}
              aria-label={cameraOn ? "Turn camera off" : "Turn camera on"}
              title={cameraOn ? "Turn camera off" : "Turn camera on"}
            >
              {cameraOn ? <Video className="size-4" /> : <VideoOff className="size-4" />}
            </Button>
            <Button
              size="icon"
              className="size-9 rounded-full bg-danger text-white hover:bg-danger/90"
              onClick={hangUp}
              aria-label="Leave"
              title="Leave"
            >
              <PhoneOff className="size-4" />
            </Button>
          </div>
        ) : (
          <div className="flex flex-wrap items-start justify-center gap-0.5 px-2 py-2 sm:gap-1">
            <ControlButton
              icon={held ? Play : Pause}
              label={held ? "Resume" : "Hold"}
              active={held}
              disabled={!active || remoteCount === 0}
              onClick={() => void toggleHold()}
            />
            <ControlButton
              icon={MessageSquare}
              label="Chat"
              active={panel === "chat"}
              disabled={!chatAvailable}
              title={chatAvailable ? "Chat" : "Open this request to chat during the call"}
              onClick={() => togglePanel("chat")}
            />
            <ControlButton
              icon={Users}
              label="People"
              badge={roster.length || undefined}
              active={panel === "people"}
              onClick={() => togglePanel("people")}
            />
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <ControlButton icon={LayoutGrid} label="View" title="Change the layout" />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="center" className={MENU_Z}>
                <LayoutItem
                  icon={User}
                  label="Speaker"
                  selected={effectiveLayout === "speaker"}
                  onSelect={() => chooseLayout("speaker")}
                />
                <LayoutItem
                  icon={Columns2}
                  label="Side by side"
                  selected={effectiveLayout === "side"}
                  onSelect={() => chooseLayout("side")}
                />
                {screenShown && (
                  <>
                    <DropdownMenuSeparator />
                    <LayoutItem
                      icon={Monitor}
                      label="Content only"
                      selected={effectiveLayout === "content"}
                      onSelect={() => chooseLayout("content")}
                    />
                    <LayoutItem
                      icon={LayoutTemplate}
                      label="Content + people"
                      selected={effectiveLayout === "content-people"}
                      onSelect={() => chooseLayout("content-people")}
                    />
                  </>
                )}
              </DropdownMenuContent>
            </DropdownMenu>

            <Divider />

            <div className="flex items-start">
              <ControlButton
                icon={cameraOn ? Video : VideoOff}
                label="Camera"
                active={cameraOn}
                disabled={!active || held}
                onClick={() => void toggleCamera()}
              />
              <DeviceMenu
                handle={active ? handleRef.current : null}
                label="Choose a camera"
                kinds={[{ kind: "videoinput", title: "Camera" }]}
                onError={setNotice}
              />
            </div>
            <div className="flex items-start">
              <ControlButton
                icon={muted ? MicOff : Mic}
                label="Mic"
                active={!muted}
                disabled={!active || held}
                onClick={() => void toggleMute()}
              />
              <DeviceMenu
                handle={active ? handleRef.current : null}
                label="Choose a microphone or speaker"
                kinds={
                  speakersSupported
                    ? [
                        { kind: "audioinput", title: "Microphone" },
                        { kind: "audiooutput", title: "Speaker" },
                      ]
                    : [{ kind: "audioinput", title: "Microphone" }]
                }
                onError={setNotice}
              />
            </div>
            <ControlButton
              icon={sharing ? MonitorOff : MonitorUp}
              label={sharing ? "Stop" : "Share"}
              active={sharing}
              disabled={!active || remoteCount === 0}
              title={sharing ? "Stop sharing your screen" : "Share your screen"}
              onClick={() => void toggleShare()}
            />
            {hasRemoteScreen && !sharing && (
              <ControlButton
                icon={controlGranted ? MousePointerClick : MousePointer2}
                label={controlGranted ? "Release" : controlAsking ? "Asking…" : "Request"}
                active={controlGranted}
                disabled={controlAsking}
                title={
                  controlGranted
                    ? "Stop pointing on their screen"
                    : `Ask ${otherName} to let you point on their screen`
                }
                onClick={controlGranted ? releaseControl : requestControl}
              />
            )}

            <Divider />

            <ControlButton icon={PhoneOff} label="Leave" danger onClick={hangUp} />
          </div>
        )}
      </div>

      {sharing && active && (
        <ScreenShareBar
          muted={muted}
          cameraOn={cameraOn}
          shareAudio={shareAudio}
          optimized={optimized}
          layout={isContentLayout(layout) ? layout : "content-people"}
          control={controlGranted ? "granted" : controlRequest ? "requested" : "none"}
          viewerName={otherName}
          onToggleMute={() => void toggleMute()}
          onToggleCamera={() => void toggleCamera()}
          onToggleShareAudio={() => void toggleShareAudio()}
          onToggleOptimized={() => void toggleOptimized()}
          onLayout={(l) => chooseLayout(l, true)}
          onGiveControl={giveControl}
          onTakeBackControl={takeBackControl}
          onDenyControl={denyControl}
          onStop={() => void stopShare()}
        />
      )}
      {/* Sharing this very tab: the pointer goes over the whole page, so it is inside the shared
          picture itself and the sharer sees it wherever they look. */}
      {sharing && shareSurface === "browser" && remotePointer && (
        <div className="pointer-events-none fixed inset-0 z-[1400]">
          <PointerCursor
            left={remotePointer.x * window.innerWidth}
            top={remotePointer.y * window.innerHeight}
            name={otherName}
            clicking={remotePointer.down}
          />
        </div>
      )}
    </div>
  );
}

function isContentLayout(layout: CallLayout): boolean {
  return layout === "content" || layout === "content-people";
}

/* ------------------------------- Toolbar bits ------------------------------ */

interface ControlButtonProps {
  icon: ComponentType<{ className?: string }>;
  label: string;
  onClick?: () => void;
  active?: boolean;
  disabled?: boolean;
  danger?: boolean;
  title?: string;
  badge?: number;
}

const ControlButton = forwardRef<HTMLButtonElement, ControlButtonProps>(function ControlButton(
  { icon: Icon, label, onClick, active, disabled, danger, title, badge, ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-pressed={active}
      aria-label={label}
      title={title ?? label}
      className="flex flex-col items-center gap-1 rounded-xl px-1.5 py-1 text-[10px] font-medium text-muted-foreground transition-colors hover:text-foreground disabled:pointer-events-none disabled:opacity-40"
      {...rest}
    >
      <span
        className={cn(
          "relative grid size-10 place-items-center rounded-full border border-border bg-background transition-colors",
          active && "border-foreground bg-foreground text-background",
          danger && "border-danger bg-danger text-white",
        )}
      >
        <Icon className="size-[18px]" />
        {badge !== undefined && (
          <span className="absolute -right-1 -top-1 min-w-4 rounded-full bg-primary px-1 text-center text-[9px] leading-4 text-primary-foreground">
            {badge}
          </span>
        )}
      </span>
      <span className="hidden sm:block">{label}</span>
    </button>
  );
});

function Divider() {
  return <span aria-hidden="true" className="mx-0.5 mt-1 h-8 w-px bg-border" />;
}

function LayoutItem({
  icon: Icon,
  label,
  selected,
  onSelect,
}: {
  icon: ComponentType<{ className?: string }>;
  label: string;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <DropdownMenuItem onSelect={onSelect}>
      <span className={cn("grid size-4 place-items-center", !selected && "invisible")}>
        <Check />
      </span>
      <Icon className="size-4" /> {label}
    </DropdownMenuItem>
  );
}

/** The little chevron beside Camera and Mic: pick which device to use. Devices are read when the
 *  menu opens, so a headset plugged in mid-call shows up. */
function DeviceMenu({
  handle,
  label,
  kinds,
  onError,
}: {
  handle: CallHandle | null;
  label: string;
  kinds: { kind: MediaDeviceKind; title: string }[];
  onError: (message: string) => void;
}) {
  const [lists, setLists] = useState<Partial<Record<MediaDeviceKind, MediaDeviceInfo[]>>>({});
  const [activeIds, setActiveIds] = useState<Partial<Record<MediaDeviceKind, string | undefined>>>({});

  async function load() {
    if (!handle) return;
    const next: typeof lists = {};
    const act: typeof activeIds = {};
    for (const { kind } of kinds) {
      try {
        next[kind] = await handle.listDevices(kind);
      } catch {
        next[kind] = [];
      }
      act[kind] = handle.activeDevice(kind);
    }
    setLists(next);
    setActiveIds(act);
  }

  function pick(kind: MediaDeviceKind, deviceId: string) {
    void handle
      ?.switchDevice(kind, deviceId)
      .then(() => setActiveIds((a) => ({ ...a, [kind]: deviceId })))
      .catch((e) => onError(callErrorMessage(e)));
  }

  return (
    <DropdownMenu onOpenChange={(open) => open && void load()}>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          disabled={!handle}
          aria-label={label}
          title={label}
          className="-ml-1.5 mt-2.5 grid size-5 place-items-center rounded-full text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:pointer-events-none disabled:opacity-40"
        >
          <ChevronDown className="size-3.5" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="center" className={cn("w-72", MENU_Z)}>
        {kinds.map(({ kind, title }, i) => {
          const list = lists[kind] ?? [];
          const activeId = activeIds[kind];
          return (
            <Fragment key={kind}>
              {i > 0 && <DropdownMenuSeparator />}
              <p className="px-2 py-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                {title}
              </p>
              {list.length === 0 ? (
                <p className="px-2 pb-1.5 text-xs text-muted-foreground">No devices found</p>
              ) : (
                list.map((d, j) => {
                  // Before anything is switched, LiveKit reports no active id: the first is the default.
                  const selected = activeId ? activeId === d.deviceId : j === 0;
                  return (
                    <DropdownMenuItem key={d.deviceId || j} onSelect={() => pick(kind, d.deviceId)}>
                      <span className={cn("grid size-4 place-items-center", !selected && "invisible")}>
                        <Check />
                      </span>
                      <span className="truncate">{d.label || `${title} ${j + 1}`}</span>
                    </DropdownMenuItem>
                  );
                })
              )}
            </Fragment>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/* --------------------------------- Panels --------------------------------- */

function SidePanel({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  return (
    <aside className="flex w-80 shrink-0 flex-col border-l border-border bg-background sm:w-96">
      <div className="flex items-center justify-between gap-2 border-b border-border px-3 py-2">
        <p className="text-sm font-medium">{title}</p>
        <Button
          variant="ghost"
          size="icon"
          className="size-7 text-muted-foreground"
          onClick={onClose}
          aria-label={`Close ${title.toLowerCase()}`}
        >
          <X className="size-4" />
        </Button>
      </div>
      {children}
    </aside>
  );
}

function PeopleList({ roster }: { roster: RosterEntry[] }) {
  if (roster.length === 0) {
    return <p className="p-4 text-center text-xs text-muted-foreground">Nobody here yet.</p>;
  }
  return (
    <ul className="space-y-0.5 overflow-y-auto p-2">
      {roster.map((r) => (
        <li key={r.identity} className="flex items-center gap-2.5 rounded-lg px-2 py-1.5">
          <span
            className={cn(
              "grid size-8 shrink-0 place-items-center rounded-full bg-primary-tint text-[11px] font-semibold text-primary",
              r.speaking && "ring-2 ring-success ring-offset-1 ring-offset-background",
            )}
          >
            {ticketInitials(r.name)}
          </span>
          <span className="min-w-0 flex-1 truncate text-sm">
            {r.name}
            {r.local && <span className="ml-1 text-xs text-muted-foreground">(you)</span>}
          </span>
          <span className="flex shrink-0 items-center gap-1.5 text-muted-foreground">
            {r.screen && <MonitorUp className="size-3.5 text-primary" aria-label="Sharing their screen" />}
            {r.camera ? (
              <Video className="size-3.5" aria-label="Camera on" />
            ) : (
              <VideoOff className="size-3.5 opacity-50" aria-label="Camera off" />
            )}
            {r.mic ? (
              <Mic className="size-3.5" aria-label="Microphone on" />
            ) : (
              <MicOff className="size-3.5 text-danger" aria-label="Muted" />
            )}
          </span>
        </li>
      ))}
    </ul>
  );
}

/* --------------------------------- Helpers -------------------------------- */

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
