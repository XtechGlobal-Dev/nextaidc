// Call tones — MP3 assets shipped in public/mp3-ringtons. Ringback and ringtone loop until
// stopped; the end tone plays once. Each looping starter returns a stop() function.

import { playSound } from "@/lib/sound";

const BASE = "/mp3-ringtons";

function loopAudio(file: string, volume: number): () => void {
  const audio = new Audio(`${BASE}/${file}`);
  audio.loop = true;
  audio.volume = volume;
  void audio.play().catch(() => {});
  return () => {
    audio.pause();
    audio.currentTime = 0;
  };
}

/** What the caller hears while the other side is being rung. */
export function startRingback(): () => void {
  return loopAudio("ringing-call.mp3", 0.5);
}

/** What the callee hears — the incoming call ring. */
export function startRingtone(): () => void {
  return loopAudio("incoming-call.mp3", 0.6);
}

/** Played once when a call ends, on either side. */
export function playCallEnd(): void {
  playSound(`${BASE}/end-call.mp3`, 0.5);
}
