import { useLayoutEffect } from "react";
import { useLocation } from "react-router-dom";

/** Scroll to top on pathname change (React Router keeps scroll otherwise). Pathname only, so query/hash
 *  changes don't reset; layout effect so it lands before paint. */
export function ScrollToTop() {
  const { pathname } = useLocation();

  useLayoutEffect(() => {
    window.scrollTo(0, 0);
  }, [pathname]);

  return null;
}
