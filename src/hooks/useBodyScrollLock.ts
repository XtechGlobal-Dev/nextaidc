import { useEffect } from "react";

/**
 * Locks <body> scroll while `locked` is true — for custom overlays/drawers
 * (mobile sidebar, slide-over panels, custom modals) that don't already trap
 * scroll the way Radix dialogs/sheets do.
 *
 * Reference-counted so several overlays open at once (or overlapping mount/unmount
 * transitions) never clobber each other: the original overflow is only restored
 * once the last lock is released.
 */
let lockCount = 0;
let savedOverflow = "";
let savedPaddingRight = "";

export function useBodyScrollLock(locked: boolean) {
  useEffect(() => {
    if (!locked) return;

    if (lockCount === 0) {
      // Compensate for the disappearing scrollbar so locking doesn't shift the
      // page content sideways on desktop.
      const scrollbarWidth = window.innerWidth - document.documentElement.clientWidth;
      savedOverflow = document.body.style.overflow;
      savedPaddingRight = document.body.style.paddingRight;
      document.body.style.overflow = "hidden";
      if (scrollbarWidth > 0) document.body.style.paddingRight = `${scrollbarWidth}px`;
    }
    lockCount += 1;

    return () => {
      lockCount -= 1;
      if (lockCount === 0) {
        document.body.style.overflow = savedOverflow;
        document.body.style.paddingRight = savedPaddingRight;
      }
    };
  }, [locked]);
}
