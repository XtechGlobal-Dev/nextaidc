import { MousePointer2 } from "lucide-react";
import { cn } from "@/lib/utils";

// The shared pointer drawn over a screen share — the viewer's mouse, shown to both sides. A web
// page can't move the sharer's real cursor, so this is the browser-safe stand-in for "give control".

export interface PointerState {
  /** Fractions of the shared picture's width and height. */
  x: number;
  y: number;
  /** A click just happened — drawn as a ring for a moment. */
  down: boolean;
  at: number;
}

export function PointerCursor({
  left,
  top,
  name,
  clicking,
  className,
}: {
  left: number;
  top: number;
  name: string;
  clicking: boolean;
  className?: string;
}) {
  return (
    <div
      className={cn("pointer-events-none absolute z-20", className)}
      style={{ left, top }}
      data-remote-pointer
      aria-hidden="true"
    >
      {clicking && (
        <span className="absolute -left-3 -top-3 size-6 animate-ping rounded-full border-2 border-primary motion-reduce:hidden" />
      )}
      <MousePointer2 className="size-5 fill-primary text-white drop-shadow-md" />
      <span className="absolute left-4 top-4 whitespace-nowrap rounded-full bg-primary px-1.5 py-0.5 text-[10px] font-medium text-primary-foreground shadow">
        {name}
      </span>
    </div>
  );
}

/** Where the picture sits inside an object-contain <video>: letterboxed and centred, so a point
 *  given as fractions of the picture lands on the same spot on both sides whatever their window size. */
export function videoContentRect(
  el: HTMLVideoElement | null,
): { left: number; top: number; width: number; height: number } | null {
  if (!el) return null;
  const boxW = el.clientWidth;
  const boxH = el.clientHeight;
  if (!boxW || !boxH) return null;
  const vw = el.videoWidth;
  const vh = el.videoHeight;
  if (!vw || !vh) return { left: 0, top: 0, width: boxW, height: boxH };
  const scale = Math.min(boxW / vw, boxH / vh);
  const width = vw * scale;
  const height = vh * scale;
  return { left: (boxW - width) / 2, top: (boxH - height) / 2, width, height };
}
