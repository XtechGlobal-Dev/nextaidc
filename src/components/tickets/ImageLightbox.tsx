import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { ChevronLeft, ChevronRight, Download, X, ZoomIn, ZoomOut } from "lucide-react";
import { cn } from "@/lib/utils";
import { useBodyScrollLock } from "@/hooks/useBodyScrollLock";
import { formatBytes } from "@/lib/ticketFiles";
import type { TicketAttachment } from "@/types/ticket";

/* ------------------------------------------------------------------ *
 *  Full-screen viewer for the images in a conversation.
 *
 *  Opening a screenshot in a new browser tab loses the thread you were
 *  reading; this keeps you in it, and lets ← / → walk every image in
 *  the conversation without going back to hunt for the next one.
 * ------------------------------------------------------------------ */

export interface ImageLightboxProps {
  /** Every image in the thread, in conversation order. */
  items: TicketAttachment[];
  /** Which one is open; null closes the viewer. */
  index: number | null;
  onIndexChange: (index: number) => void;
  onClose: () => void;
}

export function ImageLightbox({ items, index, onIndexChange, onClose }: ImageLightboxProps) {
  const open = index !== null && !!items[index];
  const [zoomed, setZoomed] = useState(false);
  useBodyScrollLock(open);

  // A fresh image always opens fitted, however the last one was left.
  useEffect(() => setZoomed(false), [index]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      if (e.key === "ArrowRight" && index !== null && index < items.length - 1) {
        onIndexChange(index + 1);
      }
      if (e.key === "ArrowLeft" && index !== null && index > 0) onIndexChange(index - 1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, index, items.length, onClose, onIndexChange]);

  if (!open || index === null) return null;
  const current = items[index];

  return createPortal(
    <div
      className="fixed inset-0 z-[100] flex flex-col bg-black/90 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-label={current.name}
      // Clicking the backdrop closes; clicks inside the image or the bars don't
      // bubble here, so a stray click while zooming doesn't dump you out.
      onClick={onClose}
    >
      <header
        className="flex items-center gap-3 px-4 py-3 text-white"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium">{current.name}</p>
          <p className="text-xs text-white/60">
            {formatBytes(current.size)}
            {items.length > 1 && ` · ${index + 1} of ${items.length}`}
          </p>
        </div>
        <button
          type="button"
          onClick={() => setZoomed((z) => !z)}
          className="rounded-lg p-2 hover:bg-white/10"
          aria-label={zoomed ? "Fit to screen" : "Zoom in"}
        >
          {zoomed ? <ZoomOut className="size-5" /> : <ZoomIn className="size-5" />}
        </button>
        <a
          href={current.url}
          download={current.name}
          target="_blank"
          rel="noreferrer"
          className="rounded-lg p-2 hover:bg-white/10"
          aria-label={`Download ${current.name}`}
        >
          <Download className="size-5" />
        </a>
        <button
          type="button"
          onClick={onClose}
          className="rounded-lg p-2 hover:bg-white/10"
          aria-label="Close"
        >
          <X className="size-5" />
        </button>
      </header>

      <div
        className={cn(
          "relative flex min-h-0 flex-1 items-center justify-center p-4",
          zoomed && "overflow-auto",
        )}
      >
        {index > 0 && (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onIndexChange(index - 1);
            }}
            className="absolute left-2 z-10 grid size-10 place-items-center rounded-full bg-black/50 text-white hover:bg-black/70"
            aria-label="Previous image"
          >
            <ChevronLeft className="size-6" />
          </button>
        )}

        <img
          src={current.url}
          alt={current.name}
          onClick={(e) => {
            e.stopPropagation();
            setZoomed((z) => !z);
          }}
          className={cn(
            "select-none",
            zoomed ? "max-w-none cursor-zoom-out" : "max-h-full max-w-full cursor-zoom-in object-contain",
          )}
        />

        {index < items.length - 1 && (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onIndexChange(index + 1);
            }}
            className="absolute right-2 z-10 grid size-10 place-items-center rounded-full bg-black/50 text-white hover:bg-black/70"
            aria-label="Next image"
          >
            <ChevronRight className="size-6" />
          </button>
        )}
      </div>
    </div>,
    document.body,
  );
}
