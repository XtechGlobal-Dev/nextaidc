import { useEffect } from "react";
import { useRouteError } from "react-router-dom";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { isChunkLoadError, reloadForStaleChunk } from "@/lib/chunkReload";

/** Route `errorElement`. The data router swallows errors before any React error boundary, so without this
 *  users saw React Router's unstyled default page flash. Stale chunk reloads once (spinner); else a Reload card. */
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
