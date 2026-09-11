import { useEffect } from "react";
import { useRouteError } from "react-router-dom";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { isChunkLoadError, reloadForStaleChunk } from "@/lib/chunkReload";

/**
 * `errorElement` for the data router. Without it, a route render error or a stale
 * lazy-chunk import failure (common right after a deploy) makes React Router show
 * its OWN unstyled default page — raw black-on-white error text, no app CSS — for
 * a moment before anything else happens. That flash is what users were seeing.
 *
 * The top-level <ErrorBoundary> in main.tsx can't help here: the data router
 * catches these errors before they reach a React error boundary, so the fallback
 * has to live on the route via `errorElement`.
 *
 * Behaviour:
 *  - Stale-chunk failure → reload ONCE to pull the fresh build (guarded against
 *    loops by reloadForStaleChunk), showing a neutral spinner, not an error.
 *  - Anything else → a branded "Something went wrong" card with a Reload action.
 */
export function RouteError() {
  const error = useRouteError();
  const chunk = isChunkLoadError(error);

  useEffect(() => {
    if (chunk) reloadForStaleChunk();
  }, [chunk]);

  if (chunk) {
    // A self-healing reload is in flight — keep it neutral so users never see an
    // error for the routine post-deploy stale-chunk case.
    return (
      <div className="flex min-h-screen items-center justify-center">
        <Loader2 className="size-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-4 p-6 text-center">
      <h1 className="text-lg font-semibold text-foreground">Something went wrong</h1>
      <p className="max-w-sm text-sm text-muted-foreground">
        We hit an unexpected error loading this page. Reloading usually fixes it.
      </p>
      <Button onClick={() => window.location.reload()}>Reload</Button>
    </div>
  );
}
