import {
  DisconnectReason,
  Room,
  RoomEvent,
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
}

export interface CallHandle {
  room: Room;
  leave: () => Promise<void>;
  setMuted: (muted: boolean) => Promise<void>;
  setCamera: (on: boolean) => Promise<void>;
  startAudio: () => Promise<void>;
}

export async function connectToCall(grant: CallGrant, cb: CallCallbacks): Promise<CallHandle> {
  const room = new Room({ adaptiveStream: true, dynacast: true });
  const remoteCount = () => cb.onRemoteCount(room.remoteParticipants.size);
  const onDisconnected = (reason?: DisconnectReason) => {
    console.info("[call] disconnected from room", reason);
    cb.onDisconnected(reason);
  };

  room
    .on(RoomEvent.TrackSubscribed, (track, _pub, participant) => cb.onRemoteTrack(track, participant))
    .on(RoomEvent.TrackUnsubscribed, (track) => cb.onRemoteTrackRemoved(track))
    .on(RoomEvent.ParticipantConnected, remoteCount)
    .on(RoomEvent.ParticipantDisconnected, remoteCount)
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
  cb.onAudioBlocked(!room.canPlaybackAudio);

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
  };
}

/** Why the room dropped us, in words. The same account joining from a second tab or browser is the
 *  one case that isn't a network problem: LiveKit keeps the newest session and shows the older one out. */
export function disconnectMessage(reason: DisconnectReason | undefined): string {
  return reason === DisconnectReason.DUPLICATE_IDENTITY
    ? "This call was picked up in another window."
    : "Connection lost";
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
