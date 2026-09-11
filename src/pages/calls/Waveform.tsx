import { useEffect, useMemo, useRef, useState } from "react";
import { Pause, Play, Download, Share2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { formatDuration } from "@/lib/utils";

const BAR_COUNT = 44;
const TICK_MS = 100;
const SPEEDS = [0.5, 1, 2, 3] as const;

/**
 * Audio player with a CSS-bar "waveform".
 *  - When `recordingUrl` is present, it plays the real recording via a hidden
 *    <audio> element (real play/pause/seek/elapsed).
 *  - Otherwise there is no audio file, so playback is *simulated* with a timer
 *    that advances an elapsed position across `durationSec`.
 */
export function Waveform({
  durationSec,
  seed,
  onDownload,
  onShare,
  sharing,
  autoPlayKey,
  recordingUrl,
}: {
  durationSec: number;
  seed: string;
  onDownload: () => void;
  /** Copy a shareable link to this recording. Omitted when there is nothing to
   *  share (no audio), so the button simply doesn't render. */
  onShare?: () => void;
  /** A share link is being minted — the button waits rather than firing twice. */
  sharing?: boolean;
  /**
   * When this value changes, playback (re)starts from the beginning. Lets a
   * caller (e.g. the row "Play Recording" action) trigger playback externally.
   */
  autoPlayKey?: number;
  /** Real recording URL — when set, actual audio plays instead of a simulation. */
  recordingUrl?: string;
}) {
  const hasAudio = Boolean(recordingUrl);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [playing, setPlaying] = useState(false);
  const [elapsed, setElapsed] = useState(0); // seconds, fractional
  const [audioDuration, setAudioDuration] = useState(0);
  const [speed, setSpeed] = useState(1);
  const [dragging, setDragging] = useState(false);
  const lastTickRef = useRef<number>(0);
  const prevAutoPlayKey = useRef(autoPlayKey);

  const duration = hasAudio ? audioDuration || Math.max(durationSec, 0) : Math.max(durationSec, 0);

  // Deterministic pseudo-random bar heights derived from the seed string,
  // so a given call always renders the same waveform.
  const bars = useMemo(() => {
    const out: number[] = [];
    let h = 0;
    for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
    for (let i = 0; i < BAR_COUNT; i++) {
      h = (h * 1103515245 + 12345) >>> 0;
      out.push(20 + (h % 80));
    }
    return out;
  }, [seed]);

  // Drive the *simulated* playback clock (only when there's no real audio).
  useEffect(() => {
    if (hasAudio || !playing) return;
    if (duration === 0) {
      setPlaying(false);
      return;
    }
    lastTickRef.current = performance.now();
    const id = window.setInterval(() => {
      const now = performance.now();
      const deltaSec = ((now - lastTickRef.current) / 1000) * speed;
      lastTickRef.current = now;
      setElapsed((prev) => {
        const next = prev + deltaSec;
        if (next >= duration) {
          setPlaying(false);
          return duration;
        }
        return next;
      });
    }, TICK_MS);
    return () => window.clearInterval(id);
  }, [hasAudio, playing, duration, speed]);

  // Keep the real <audio> element's rate in sync with the selected speed.
  useEffect(() => {
    if (audioRef.current) audioRef.current.playbackRate = speed;
  }, [speed, recordingUrl]);

  // When the underlying call changes (different recording), reset the player.
  useEffect(() => {
    setPlaying(false);
    setElapsed(0);
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current.currentTime = 0;
    }
  }, [seed]);

  // Stop playback when the player unmounts (e.g. the call panel closes). A
  // <audio> element that's still playing keeps decoding in the background after
  // React detaches it from the DOM — the audio was heard until a full page
  // reload. Pausing and releasing the source on cleanup stops it immediately.
  useEffect(() => {
    return () => {
      const a = audioRef.current;
      if (a) {
        a.pause();
        a.removeAttribute("src");
        a.load();
      }
    };
  }, []);

  // External trigger: restart playback from 0 when the key changes (not on the
  // initial mount, so opening the panel normally does not auto-play).
  useEffect(() => {
    if (autoPlayKey === undefined) return;
    if (prevAutoPlayKey.current === autoPlayKey) return;
    prevAutoPlayKey.current = autoPlayKey;
    setElapsed(0);
    if (hasAudio) {
      const a = audioRef.current;
      if (a) {
        a.currentTime = 0;
        void a.play().catch(() => {});
      }
    } else if (duration > 0) {
      setPlaying(true);
    }
  }, [autoPlayKey, duration, hasAudio]);

  const progress = duration === 0 ? 0 : Math.min(elapsed / duration, 1);

  function toggle() {
    if (hasAudio) {
      const a = audioRef.current;
      if (!a) return;
      if (a.paused) {
        if (duration > 0 && elapsed >= duration) a.currentTime = 0;
        void a.play().catch(() => {});
      } else {
        a.pause();
      }
      return;
    }
    if (duration === 0) return;
    setPlaying((p) => {
      if (!p && elapsed >= duration) setElapsed(0);
      return !p;
    });
  }

  function seekToClientX(el: HTMLElement, clientX: number) {
    if (duration === 0) return;
    const rect = el.getBoundingClientRect();
    const ratio = Math.min(Math.max((clientX - rect.left) / rect.width, 0), 1);
    const pos = ratio * duration;
    setElapsed(pos);
    if (hasAudio && audioRef.current) audioRef.current.currentTime = pos;
    lastTickRef.current = performance.now();
  }

  return (
    <div className="flex flex-col gap-2.5 rounded-[var(--radius-card)] border border-border bg-warm p-3">
      {hasAudio && (
        <audio
          ref={audioRef}
          src={recordingUrl}
          preload="metadata"
          className="hidden"
          onLoadedMetadata={(e) => {
            const d = e.currentTarget.duration;
            if (Number.isFinite(d)) setAudioDuration(d);
          }}
          onTimeUpdate={(e) => setElapsed(e.currentTarget.currentTime)}
          onPlay={() => setPlaying(true)}
          onPause={() => setPlaying(false)}
          onEnded={() => setPlaying(false)}
        />
      )}

      {/* Row 1: play/pause + waveform */}
      <div className="flex items-center gap-3">
      <Button
        type="button"
        variant="primary"
        size="icon"
        aria-label={playing ? "Pause recording" : "Play recording"}
        disabled={!hasAudio && duration === 0}
        onClick={toggle}
      >
        {playing ? <Pause /> : <Play />}
      </Button>

      <div
        role="slider"
        aria-label="Seek recording"
        aria-valuemin={0}
        aria-valuemax={Math.round(duration)}
        aria-valuenow={Math.round(elapsed)}
        tabIndex={0}
        onPointerDown={(e) => {
          if (duration === 0) return;
          e.currentTarget.setPointerCapture(e.pointerId);
          setDragging(true);
          seekToClientX(e.currentTarget, e.clientX);
        }}
        onPointerMove={(e) => {
          if (!dragging) return;
          seekToClientX(e.currentTarget, e.clientX);
        }}
        onPointerUp={(e) => {
          if (!dragging) return;
          setDragging(false);
          e.currentTarget.releasePointerCapture(e.pointerId);
        }}
        onKeyDown={(e) => {
          if (duration === 0) return;
          if (e.key === "ArrowRight") {
            const pos = Math.min(duration, elapsed + 1);
            setElapsed(pos);
            if (hasAudio && audioRef.current) audioRef.current.currentTime = pos;
          }
          if (e.key === "ArrowLeft") {
            const pos = Math.max(0, elapsed - 1);
            setElapsed(pos);
            if (hasAudio && audioRef.current) audioRef.current.currentTime = pos;
          }
        }}
        className="flex flex-1 cursor-pointer flex-col gap-1.5 overflow-hidden"
      >
        {/* Two full-width bar layers: the played one is clipped to the exact same
            `progress` fraction as the bar below, so both fill in lockstep. */}
        <div className="relative h-10 w-full">
          <div className="absolute inset-0 flex items-center justify-between">
            {bars.map((height, i) => (
              <span
                key={i}
                className="w-1 shrink-0 rounded-full bg-primary/30"
                style={{ height: `${height}%` }}
              />
            ))}
          </div>
          <div
            className={`absolute inset-0 flex items-center justify-between ${
              dragging ? "" : "transition-[clip-path] duration-100 ease-linear"
            }`}
            style={{ clipPath: `inset(0 ${100 - progress * 100}% 0 0)` }}
          >
            {bars.map((height, i) => (
              <span
                key={i}
                className="w-1 shrink-0 rounded-full bg-primary"
                style={{ height: `${height}%` }}
              />
            ))}
          </div>
        </div>
        <div className="h-1 w-full overflow-hidden rounded-full bg-primary/15">
          <div
            className={`h-full rounded-full bg-primary ${
              dragging ? "" : "transition-[width] duration-100 ease-linear"
            }`}
            style={{ width: `${progress * 100}%` }}
          />
        </div>
      </div>
      </div>

      {/* Row 2: elapsed/total time, playback speed, download */}
      <div className="flex items-center gap-2">
        <span className="text-xs tabular-nums text-muted-foreground">
          {formatDuration(Math.round(elapsed))} / {formatDuration(Math.round(duration))}
        </span>

        <div className="ml-auto flex items-center gap-1">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            aria-label={`Playback speed ${speed}x`}
            title="Playback speed"
            className="w-12 shrink-0 tabular-nums"
            onClick={() => setSpeed((s) => SPEEDS[(SPEEDS.indexOf(s as (typeof SPEEDS)[number]) + 1) % SPEEDS.length])}
          >
            {speed}x
          </Button>

          {/* Labelled, not an icon on its own: a bare chain-link beside a
              download arrow reads as "open the file somewhere", and nobody
              guessed it copied a shareable link. The label drops on very narrow
              screens, where the share arrow at least isn't competing with a
              second link-shaped glyph. */}
          {onShare && hasAudio && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              aria-label="Copy share link"
              title="Copy a link to this recording"
              disabled={sharing}
              onClick={onShare}
              className="shrink-0 gap-1.5 px-2"
            >
              <Share2 />
              <span className="hidden sm:inline">Share</span>
            </Button>
          )}

          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label="Download recording"
            title="Download recording"
            onClick={() => {
              if (!recordingUrl) {
                onDownload();
                return;
              }
              // `?download=1` makes the server send Content-Disposition:
              // attachment with a readable filename. Driving a hidden <a>
              // instead of window.open keeps it a download — opening a tab left
              // the user staring at a bare audio player on a black page, and
              // saving from there named the file after the signed token.
              const a = document.createElement("a");
              a.href = recordingUrl + (recordingUrl.includes("?") ? "&" : "?") + "download=1";
              a.rel = "noopener";
              a.style.display = "none";
              document.body.appendChild(a);
              a.click();
              a.remove();
              onDownload();
            }}
          >
            <Download />
          </Button>
        </div>
      </div>
    </div>
  );
}
