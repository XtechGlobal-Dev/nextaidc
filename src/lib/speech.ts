import { env } from "@/lib/env";

/* ------------------------------------------------------------------ *
 *  speech — speaks short snippets via the server TTS proxy (the same
 *  provider + voices the live agent uses: Deepgram Aura-2 by default,
 *  ElevenLabs when the admin flips the global toggle). We fetch the FULL
 *  clip before playing so the audio always plays to the end (a
 *  progressively-streamed <audio> can fire "ended" early and clip the
 *  voice). To keep it snappy, clips are cached and can be prefetched, so
 *  a warmed line plays instantly. Only one clip plays at a time, and a
 *  monotonic token guarantees only the most recent speak() ever plays.
 *
 *  Playback goes through a shared, kept-alive Web Audio context with a
 *  short silent lead-in. Windows/Chrome (and most Bluetooth outputs) power
 *  the audio device down after a brief silence; the first ~200–400ms of the
 *  next sound is then swallowed while it spins back up — which clipped the
 *  first word of every spoken line ("Analyzing" → "…lyzing"). Routing the
 *  clip through a context that's always running (an inaudible zero-gain
 *  tone) and scheduling it a beat after the device is confirmed running
 *  guarantees it plays from the very first syllable. A plain <audio>
 *  element is the fallback when Web Audio can't be used.
 * ------------------------------------------------------------------ */

export const ttsSupported = typeof window !== "undefined" && typeof Audio !== "undefined";

interface SpeakOpts {
  onStart?: () => void;
  onEnd?: () => void;
  /** Voice id — a Deepgram short name (e.g. "theia") or an ElevenLabs voice_id. */
  voiceId?: string;
  /** Explicit provider so the preview uses the right engine (the picker knows it).
   *  Omitted → the server derives it (ElevenLabs id → ElevenLabs, else global). */
  provider?: "deepgram" | "elevenlabs";
  /** Fires when the clip could not be produced or played, with the reason the
   *  server gave (e.g. an ElevenLabs "voice not found"). Without this a failed
   *  preview is indistinguishable from a silent one. onEnd still fires after. */
  onError?: (message: string) => void;
}

/** Why the clip at this URL last failed — set by the fetchers, read by speak() so
 *  the caller can surface a real reason instead of silence. */
const failureReason = new Map<string, string>();

/** Pull the server's `{ error }` message off a failed TTS response. */
async function readError(res: Response): Promise<string> {
  const body = await res.text().catch(() => "");
  try {
    const parsed = JSON.parse(body) as { error?: string };
    if (parsed.error) return parsed.error;
  } catch {
    /* not JSON — fall through to the raw body */
  }
  return body.slice(0, 200) || `Preview failed (${res.status})`;
}

/** Silence scheduled before every clip so any device warm-up falls on the lead,
 *  never on speech. Long enough to cover the worst-case spin-up, short enough to
 *  stay imperceptible. */
const LEAD_IN_SEC = 0.14;

let latest = 0;
let currentAudio: HTMLAudioElement | null = null;
let currentSource: AudioBufferSourceNode | null = null;

/* Shared context, kept running by a zero-gain tone so the output device never
 * idles. Created lazily; resumes once the page has a user gesture (every audio
 * flow here follows a click, so this reliably reaches "running"). */
let warmCtx: AudioContext | null = null;

function ensureCtx(): AudioContext | null {
  if (typeof window === "undefined") return null;
  try {
    if (!warmCtx) {
      const Ctx =
        window.AudioContext ??
        (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Ctx) return null;
      warmCtx = new Ctx();
      const gain = warmCtx.createGain();
      gain.gain.value = 0; // inaudible — this only keeps the output device active
      const osc = warmCtx.createOscillator();
      osc.connect(gain).connect(warmCtx.destination);
      osc.start();
    }
    if (warmCtx.state === "suspended") void warmCtx.resume();
    return warmCtx;
  } catch {
    return null;
  }
}

function ttsUrl(text: string, voiceId?: string, provider?: "deepgram" | "elevenlabs"): string {
  const params = new URLSearchParams({ text });
  if (voiceId) params.set("voiceId", voiceId);
  // Explicit provider when the caller knows it (picker). Otherwise the server derives
  // it from the voiceId (an ElevenLabs id → ElevenLabs, a Deepgram name → Deepgram).
  if (provider) params.set("provider", provider);
  return `${env.apiUrl}/api/tts?${params.toString()}`;
}

/* ---- Web Audio path: decoded-buffer cache ---- */
const bufferCache = new Map<string, Promise<AudioBuffer | null>>();

/** Fetch + decode (or reuse) the full clip as an AudioBuffer for the shared context. */
function getBuffer(url: string, ctx: AudioContext): Promise<AudioBuffer | null> {
  const cached = bufferCache.get(url);
  if (cached) return cached;
  const p = (async () => {
    try {
      const res = await fetch(url);
      if (!res.ok) {
        failureReason.set(url, await readError(res));
        return null;
      }
      const bytes = await res.arrayBuffer();
      if (!bytes.byteLength) {
        failureReason.set(url, "The voice returned no audio");
        return null;
      }
      failureReason.delete(url);
      return await ctx.decodeAudioData(bytes);
    } catch {
      return null;
    }
  })();
  bufferCache.set(url, p);
  // Don't cache a failure forever — let a later call retry.
  void p.then((b) => {
    if (!b) bufferCache.delete(url);
  });
  return p;
}

/* ---- <audio> fallback path: object-URL cache ---- */
const blobCache = new Map<string, string>();
const inflight = new Map<string, Promise<string | null>>();

/** Fetch (or reuse) the full audio clip for a line as a playable object URL. */
function getClip(url: string): Promise<string | null> {
  const cached = blobCache.get(url);
  if (cached) return Promise.resolve(cached);
  const pending = inflight.get(url);
  if (pending) return pending;

  const p = (async () => {
    try {
      const res = await fetch(url);
      if (!res.ok) {
        failureReason.set(url, await readError(res));
        return null;
      }
      const blob = await res.blob();
      if (!blob.size || !blob.type.startsWith("audio")) {
        failureReason.set(url, "The voice returned no audio");
        return null;
      }
      failureReason.delete(url);
      const objUrl = URL.createObjectURL(blob);
      blobCache.set(url, objUrl);
      return objUrl;
    } catch {
      return null;
    } finally {
      inflight.delete(url);
    }
  })();
  inflight.set(url, p);
  return p;
}

function stopPlayback() {
  if (currentAudio) {
    currentAudio.pause();
    currentAudio = null;
  }
  if (currentSource) {
    currentSource.onended = null; // detach so stopping doesn't fire the caller's onEnd
    try {
      currentSource.stop();
    } catch {
      /* already stopped */
    }
    currentSource = null;
  }
}

/** Play via the shared warm context with a silent lead-in. */
function playViaContext(ctx: AudioContext, buf: AudioBuffer, token: number, opts: SpeakOpts): void {
  const src = ctx.createBufferSource();
  src.buffer = buf;
  src.connect(ctx.destination);
  currentSource = src;
  src.onended = () => {
    if (currentSource === src) currentSource = null;
    opts.onEnd?.();
  };
  opts.onStart?.();
  // Start a beat in the future so the (kept-warm) device is certainly rendering
  // before the first sample of speech is due.
  src.start(ctx.currentTime + LEAD_IN_SEC);
  void token;
}

/** Fallback: play through a plain <audio> element. */
function playViaElement(url: string, token: number, opts: SpeakOpts): void {
  void getClip(url).then((objUrl) => {
    if (token !== latest) return;
    if (!objUrl) {
      // Both fetch paths failed — tell the caller why instead of playing silence.
      opts.onError?.(failureReason.get(url) ?? "Couldn't play this voice");
      opts.onEnd?.();
      return;
    }
    const audio = new Audio(objUrl);
    currentAudio = audio;
    audio.onplay = () => opts.onStart?.();
    audio.onended = () => {
      if (currentAudio === audio) currentAudio = null;
      opts.onEnd?.();
    };
    audio.onerror = () => {
      if (currentAudio === audio) currentAudio = null;
      opts.onEnd?.();
    };
    void audio.play().catch(() => {
      if (currentAudio === audio) currentAudio = null;
      opts.onEnd?.();
    });
  });
}

/** Speak `text` aloud with the chosen voice (server proxy). */
export function speak(text: string, opts: SpeakOpts = {}): void {
  if (!ttsSupported || !text.trim()) {
    opts.onEnd?.();
    return;
  }
  const token = ++latest; // supersede any previous / in-flight speak
  stopPlayback();
  const url = ttsUrl(text, opts.voiceId, opts.provider);
  const ctx = ensureCtx();

  if (!ctx) {
    playViaElement(url, token, opts);
    return;
  }

  void getBuffer(url, ctx).then(async (buf) => {
    if (token !== latest) return; // a newer speak() started → drop this one
    if (ctx.state === "suspended") {
      try {
        await ctx.resume();
      } catch {
        /* no user gesture yet */
      }
    }
    if (token !== latest) return;
    // Decode failed or the context couldn't start → fall back to <audio>.
    if (!buf || ctx.state !== "running") {
      playViaElement(url, token, opts);
      return;
    }
    playViaContext(ctx, buf, token, opts);
  });
}

/** Warm the cache (and the output device) for an upcoming line so the next
 *  speak() plays instantly and unclipped. Fire-and-forget. */
export function prefetchSpeech(
  text: string,
  voiceId?: string,
  provider?: "deepgram" | "elevenlabs",
): void {
  if (!ttsSupported || !text.trim()) return;
  const url = ttsUrl(text, voiceId, provider);
  const ctx = ensureCtx(); // warm the device early so the first spoken line isn't clipped
  if (ctx) void getBuffer(url, ctx);
  else void getClip(url);
}

/** Stop any in-progress / pending speech. */
export function stopSpeaking(): void {
  latest++; // invalidate any in-flight request
  stopPlayback();
}
