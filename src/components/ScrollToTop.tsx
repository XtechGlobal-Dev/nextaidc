import { useLayoutEffect } from "react";
import { useLocation } from "react-router-dom";

/**
 * Resets the window scroll to the top on every route (pathname) change.
 * React Router preserves scroll position across client-side navigations by
 * default, which leaves a new page scrolled halfway down — this fixes that.
 *
 * Keyed on `pathname` only (not search/hash) so query-string updates and
 * in-page anchor jumps don't force an unwanted scroll reset. Runs in a layout
 * effect so the reset happens before paint (no visible jump).
 */
export function ScrollToTop() {
  const { pathname } = useLocation();

  useLayoutEffect(() => {
    window.scrollTo(0, 0);
  }, [pathname]);

  return null;
}
