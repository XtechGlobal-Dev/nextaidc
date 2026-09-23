// Synthesised call tones — no audio assets to ship, and they start the instant
// they're needed. Each starter returns a stop() function.

let ctx: AudioContext | null = null;

function audio(): AudioContext | null {
  try {
    ctx ??= new AudioContext();
    if (ctx.state === "suspended") void ctx.resume();
    return ctx;
  } catch {
    return null;
  }
}

interface Burst {
  /** Offset within one cycle, ms. */
  at: number;
  dur: number;
  freqs: number[];
}

/** Plays `bursts` once per `cycleMs` until stopped. */
function loop(bursts: Burst[], cycleMs: number, gain: number): () => void {
  const ac = audio();
  if (!ac) return () => {};
  let stopped = false;
  let timer = 0;
  const cycle = () => {
    if (stopped) return;
    const base = ac.currentTime;
    for (const b of bursts) {
      const start = base + b.at / 1000;
      const end = start + b.dur / 1000;
      for (const f of b.freqs) {
        const osc = ac.createOscillator();
        const g = ac.createGain();
        osc.type = "sine";
        osc.frequency.value = f;
        g.gain.setValueAtTime(0, start);
        g.gain.linearRampToValueAtTime(gain, start + 0.015);
        g.gain.setValueAtTime(gain, end - 0.015);
        g.gain.linearRampToValueAtTime(0, end);
        osc.connect(g).connect(ac.destination);
        osc.start(start);
        osc.stop(end + 0.02);
      }
    }
    timer = window.setTimeout(cycle, cycleMs);
  };
  cycle();
  return () => {
    stopped = true;
    window.clearTimeout(timer);
  };
}

/** What the caller hears while the other side is being rung — a double "tir-tir". */
export function startRingback(): () => void {
  return loop(
    [
      { at: 0, dur: 400, freqs: [425] },
      { at: 600, dur: 400, freqs: [425] },
    ],
    3000,
    0.08,
  );
}

/** What the callee hears — a two-note chime. */
export function startRingtone(): () => void {
  return loop(
    [
      { at: 0, dur: 220, freqs: [659] },
      { at: 280, dur: 220, freqs: [880] },
      { at: 560, dur: 220, freqs: [659] },
      { at: 840, dur: 360, freqs: [880] },
    ],
    2600,
    0.1,
  );
}
