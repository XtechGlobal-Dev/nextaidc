import {
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

export interface CallCallbacks {
  onState: (state: TicketCallState) => void;
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

  room
    .on(RoomEvent.TrackSubscribed, (track, _pub, participant) => cb.onRemoteTrack(track, participant))
    .on(RoomEvent.TrackUnsubscribed, (track) => cb.onRemoteTrackRemoved(track))
    .on(RoomEvent.ParticipantConnected, remoteCount)
    .on(RoomEvent.ParticipantDisconnected, remoteCount)
    .on(RoomEvent.AudioPlaybackStatusChanged, () => cb.onAudioBlocked(!room.canPlaybackAudio))
    .on(RoomEvent.Disconnected, (reason) => {
      console.info("[call] disconnected from room", reason);
      cb.onState("ended");
    });

  cb.onState("connecting");
  try {
    await room.connect(grant.url, grant.token);
    await room.localParticipant.setMicrophoneEnabled(true);
    if (grant.mode === "video") await room.localParticipant.setCameraEnabled(true);
  } catch (err) {
    await room.disconnect();
    throw err;
  }
  cb.onState("active");
  remoteCount();
  cb.onAudioBlocked(!room.canPlaybackAudio);

  return {
    room,
    leave: () => room.disconnect(),
    setMuted: async (muted) => {
      await room.localParticipant.setMicrophoneEnabled(!muted);
    },
    setCamera: async (on) => {
      await room.localParticipant.setCameraEnabled(on);
    },
    startAudio: () => room.startAudio(),
  };
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
  return message || "Couldn't connect the call.";
}
