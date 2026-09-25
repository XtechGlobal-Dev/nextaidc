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

/** What you hear while the other side has you on hold — a soft four-note chime every few seconds,
 *  synthesised so there is no file to ship. */
export function startHoldTone(): () => void {
  const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctx) return () => {};
  const ctx = new Ctx();
  const master = ctx.createGain();
  master.gain.value = 0.05;
  master.connect(ctx.destination);
  const notes = [523.25, 659.25, 783.99, 659.25];
  const STEP = 0.45;
  let stopped = false;
  const chime = () => {
    if (stopped) return;
    const t0 = ctx.currentTime;
    notes.forEach((hz, i) => {
      const at = t0 + i * STEP;
      const osc = ctx.createOscillator();
      osc.type = "sine";
      osc.frequency.value = hz;
      const env = ctx.createGain();
      env.gain.setValueAtTime(0, at);
      env.gain.linearRampToValueAtTime(1, at + 0.05);
      env.gain.linearRampToValueAtTime(0, at + STEP - 0.05);
      osc.connect(env).connect(master);
      osc.start(at);
      osc.stop(at + STEP);
    });
  };
  chime();
  const id = window.setInterval(chime, 4000);
  return () => {
    stopped = true;
    window.clearInterval(id);
    void ctx.close().catch(() => {});
  };
}
