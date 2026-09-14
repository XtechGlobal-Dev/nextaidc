import { useEffect } from "react";

// Body scroll lock for custom overlays that Radix doesn't trap. Reference-counted so
// overlapping overlays don't clobber each other — overflow is restored on the last release.
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
