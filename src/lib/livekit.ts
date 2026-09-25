import {
  DisconnectReason,
  Room,
  RoomEvent,
  Track,
  type Participant,
  type RemoteParticipant,
  type RemoteTrack,
} from "livekit-client";

// In-ticket voice/video calls. The server mints a room token (see
// server/src/services/livekit.ts); this is the thin client half.

export type CallMode = "audio" | "video";
/** Why a call stopped before/while running, as told to the other side. */
export type CallEndReason = "hangup" | "declined" | "missed";

/** Named like VapiCallState so the two call surfaces read the same. */
export type TicketCallState = "idle" | "connecting" | "active" | "ended";

/** How the stage is laid out. The content layouts only apply while a screen is being shared. */
export type CallLayout = "speaker" | "side" | "content" | "content-people";

/** Small messages the two sides pass each other over the room's data channel. */
export type CallSignal =
  | { t: "hold"; on: boolean }
  | { t: "layout"; value: CallLayout }
  /** Pointer control over a shared screen: the viewer asks, the sharer answers or offers, either side ends it. */
  | { t: "control"; action: "request" | "grant" | "deny" | "revoke" | "release" }
  /** Where the viewer's pointer is over the shared content, as fractions of its width and height. */
  | { t: "pointer"; x: number; y: number; down?: boolean; hide?: boolean };

/** What the browser's picker captured — a tab ("browser"), a window, or a whole monitor. */
export type ShareSurface = "browser" | "window" | "monitor" | undefined;

const SIGNAL_TOPIC = "call";

export interface CallGrant {
  token: string;
  url: string;
  roomName: string;
  mode: CallMode;
}

/** What a ring came back with: how many open app windows it landed in. Zero means the other side
 *  has the app closed right now — they get a bell notification, not a ring. */
export interface CallRingResult {
  reached: number;
}

/** Who is on a ticket's call right now, as LiveKit sees it. */
export interface CallStatus {
  live: boolean;
  mode: CallMode;
  participants: { side: "staff" | "requester"; userId: string; name: string }[];
}

/** One person in the room, for the People panel. */
export interface RosterEntry {
  identity: string;
  name: string;
  local: boolean;
  mic: boolean;
  camera: boolean;
  screen: boolean;
  speaking: boolean;
}

export interface CallCallbacks {
  onState: (state: TicketCallState) => void;
  /** The room dropped us. Not called for a failed connect — that throws instead — nor for our own leave(). */
  onDisconnected: (reason: DisconnectReason | undefined) => void;
  /** Video call, but the camera would not start (held by another app or window, unplugged): the call
   *  goes on with audio only. The message is callErrorMessage(err). */
  onCameraFailed: (err: unknown) => void;
  onRemoteTrack: (track: RemoteTrack, participant: RemoteParticipant) => void;
  onRemoteTrackRemoved: (track: RemoteTrack) => void;
  /** How many OTHER people are in the room. */
  onRemoteCount: (count: number) => void;
  /** The browser refused to play audio without a gesture — offer a button that calls startAudio(). */
  onAudioBlocked: (blocked: boolean) => void;
  /** Everyone in the room and what they have on, whenever any of it changes. */
  onRoster: (roster: RosterEntry[]) => void;
  /** The other side sent a signal (hold, layout). */
  onSignal: (signal: CallSignal) => void;
  /** Our screen share stopped from outside the call window — the browser's own "Stop sharing" bar. */
  onScreenShareEnded: () => void;
}

export interface CallHandle {
  room: Room;
  leave: () => Promise<void>;
  setMuted: (muted: boolean) => Promise<void>;
  setCamera: (on: boolean) => Promise<void>;
  startAudio: () => Promise<void>;
  /** Silences the other side here and tells them. Muting our own mic and camera is the caller's job. */
  setHold: (on: boolean) => Promise<void>;
  /** Opens the browser's picker. Resolves once the share is published; rejects if the picker is cancelled. */
  startScreenShare: () => Promise<{ hasAudio: boolean; surface: ShareSurface }>;
  stopScreenShare: () => Promise<void>;
  /** Only works when the picker gave us system/tab audio (hasAudio). */
  setScreenShareAudio: (on: boolean) => Promise<void>;
  /** Trade sharpness for frame rate, for video content. */
  setScreenShareOptimized: (motion: boolean) => Promise<void>;
  listDevices: (kind: MediaDeviceKind) => Promise<MediaDeviceInfo[]>;
  switchDevice: (kind: MediaDeviceKind, deviceId: string) => Promise<void>;
  activeDevice: (kind: MediaDeviceKind) => string | undefined;
  /** Reliable by default; `lossy` for a stream of pointer positions where the newest is all that matters. */
  send: (signal: CallSignal, opts?: { lossy?: boolean }) => Promise<void>;
}

export async function connectToCall(grant: CallGrant, cb: CallCallbacks): Promise<CallHandle> {
  const room = new Room({ adaptiveStream: true, dynacast: true });
  const remoteCount = () => cb.onRemoteCount(room.remoteParticipants.size);
  const onDisconnected = (reason?: DisconnectReason) => {
    console.info("[call] disconnected from room", reason);
    cb.onDisconnected(reason);
  };
  const roster = () => {
    const entry = (p: Participant, local: boolean): RosterEntry => ({
      identity: p.identity,
      name: p.name || p.identity,
      local,
      mic: p.isMicrophoneEnabled,
      camera: p.isCameraEnabled,
      screen: p.isScreenShareEnabled,
      speaking: p.isSpeaking,
    });
    cb.onRoster([
      entry(room.localParticipant, true),
      ...Array.from(room.remoteParticipants.values()).map((p) => entry(p, false)),
    ]);
  };

  room
    .on(RoomEvent.TrackSubscribed, (track, _pub, participant) => {
      cb.onRemoteTrack(track, participant);
      roster();
    })
    .on(RoomEvent.TrackUnsubscribed, (track) => {
      cb.onRemoteTrackRemoved(track);
      roster();
    })
    .on(RoomEvent.ParticipantConnected, () => {
      remoteCount();
      roster();
    })
    .on(RoomEvent.ParticipantDisconnected, () => {
      remoteCount();
      roster();
    })
    .on(RoomEvent.TrackMuted, roster)
    .on(RoomEvent.TrackUnmuted, roster)
    .on(RoomEvent.TrackPublished, roster)
    .on(RoomEvent.TrackUnpublished, roster)
    .on(RoomEvent.LocalTrackPublished, roster)
    .on(RoomEvent.LocalTrackUnpublished, (pub) => {
      if (pub.source === Track.Source.ScreenShare) cb.onScreenShareEnded();
      roster();
    })
    .on(RoomEvent.ActiveSpeakersChanged, roster)
    .on(RoomEvent.DataReceived, (payload, _participant, _kind, topic) => {
      if (topic !== SIGNAL_TOPIC) return;
      try {
        cb.onSignal(JSON.parse(new TextDecoder().decode(payload)) as CallSignal);
      } catch {
        // Not ours to read.
      }
    })
    .on(RoomEvent.AudioPlaybackStatusChanged, () => cb.onAudioBlocked(!room.canPlaybackAudio))
    .on(RoomEvent.Disconnected, onDisconnected);

  cb.onState("connecting");
  try {
    await room.connect(grant.url, grant.token);
    await room.localParticipant.setMicrophoneEnabled(true);
  } catch (err) {
    // Our own tear-down, not a drop: the error is the story, so the leave must not be reported as
    // "connection lost" over it.
    room.off(RoomEvent.Disconnected, onDisconnected);
    await room.disconnect();
    throw err;
  }
  if (grant.mode === "video") {
    // A camera that will not start is no reason to drop a call the microphone already carries.
    try {
      await room.localParticipant.setCameraEnabled(true);
    } catch (err) {
      cb.onCameraFailed(err);
    }
  }
  cb.onState("active");
  remoteCount();
  roster();
  cb.onAudioBlocked(!room.canPlaybackAudio);

  const send = async (signal: CallSignal, opts?: { lossy?: boolean }) => {
    await room.localParticipant.publishData(new TextEncoder().encode(JSON.stringify(signal)), {
      reliable: !opts?.lossy,
      topic: SIGNAL_TOPIC,
    });
  };

  return {
    room,
    leave: () => {
      room.off(RoomEvent.Disconnected, onDisconnected);
      return room.disconnect();
    },
    setMuted: async (muted) => {
      await room.localParticipant.setMicrophoneEnabled(!muted);
    },
    setCamera: async (on) => {
      await room.localParticipant.setCameraEnabled(on);
    },
    startAudio: () => room.startAudio(),
    setHold: async (on) => {
      room.remoteParticipants.forEach((p) => p.setVolume(on ? 0 : 1));
      await send({ t: "hold", on });
    },
    startScreenShare: async () => {
      const pub = await room.localParticipant.setScreenShareEnabled(true, {
        audio: true,
        systemAudio: "include",
        selfBrowserSurface: "include",
        contentHint: "detail",
      });
      const settings = pub?.track?.mediaStreamTrack.getSettings() as
        | (MediaTrackSettings & { displaySurface?: string })
        | undefined;
      const surface = settings?.displaySurface;
      return {
        hasAudio: !!room.localParticipant.getTrackPublication(Track.Source.ScreenShareAudio),
        surface: surface === "browser" || surface === "window" || surface === "monitor" ? surface : undefined,
      };
    },
    stopScreenShare: async () => {
      await room.localParticipant.setScreenShareEnabled(false);
    },
    setScreenShareAudio: async (on) => {
      const track = room.localParticipant.getTrackPublication(Track.Source.ScreenShareAudio)?.track;
      if (!track) return;
      if (on) await track.unmute();
      else await track.mute();
    },
    setScreenShareOptimized: async (motion) => {
      const stream = room.localParticipant.getTrackPublication(Track.Source.ScreenShare)?.track
        ?.mediaStreamTrack;
      if (!stream) return;
      stream.contentHint = motion ? "motion" : "detail";
      try {
        await stream.applyConstraints({ frameRate: motion ? 30 : 15 });
      } catch {
        // The hint alone still steers the encoder; a browser that refuses the frame rate is fine.
      }
    },
    listDevices: (kind) => Room.getLocalDevices(kind),
    switchDevice: async (kind, deviceId) => {
      await room.switchActiveDevice(kind, deviceId);
    },
    activeDevice: (kind) => room.getActiveDevice(kind),
    send,
  };
}

/** Why the room dropped us, in words. The same account joining from a second tab or browser is the
 *  one case that isn't a network problem: LiveKit keeps the newest session and shows the older one out. */
export function disconnectMessage(reason: DisconnectReason | undefined): string {
  return reason === DisconnectReason.DUPLICATE_IDENTITY
    ? "This call was picked up in another window."
    : "Connection lost";
}

/** The person closed the browser's share picker without choosing anything — not an error to show. */
export function isPickerCancelled(err: unknown): boolean {
  return err instanceof Error && err.name === "NotAllowedError";
}

/** What to tell someone when the call couldn't start. Device errors are the common case. */
export function callErrorMessage(err: unknown): string {
  const name = err instanceof Error ? err.name : "";
  const message = err instanceof Error ? err.message : "";
  if (name === "NotAllowedError" || /permission/i.test(message)) {
    return "Allow microphone (and camera) access in your browser, then try again.";
  }
  if (name === "NotFoundError" || /device not found|no device/i.test(message)) {
    return "No microphone or camera was found on this device.";
  }
  // Chrome: NotReadableError; Firefox: AbortError "Starting videoinput failed". Windows gives a
  // camera to one process at a time, so two browsers on one PC is the everyday way to hit this.
  if (
    name === "NotReadableError" ||
    (name === "AbortError" && /start/i.test(message)) ||
    /could not start|in use|already in use/i.test(message)
  ) {
    return "The camera or microphone is in use by another app or browser window. Free it there, then try again.";
  }
  return message || "Couldn't connect the call.";
}
