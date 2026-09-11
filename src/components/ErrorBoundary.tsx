import { Component, type ErrorInfo, type ReactNode } from "react";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { isChunkLoadError, reloadForStaleChunk } from "@/lib/chunkReload";

interface State {
  hasError: boolean;
  /** A stale-chunk failure with an auto-reload in flight — show a spinner, not
   *  a false "Something went wrong" flash while the page refreshes. */
  reloading: boolean;
}

/**
 * Catches render + lazy-import errors so a thrown route never blanks the whole
 * app. A stale-chunk failure (after a deploy) auto-reloads once to pull the new
 * build — showing a neutral spinner while it does; anything else shows a
 * friendly "Reload" fallback instead of a white screen.
 */
export class ErrorBoundary extends Component<{ children: ReactNode }, State> {
  state: State = { hasError: false, reloading: false };

  static getDerivedStateFromError(error: unknown): State {
    return { hasError: true, reloading: isChunkLoadError(error) };
  }

  componentDidCatch(error: unknown, _info: ErrorInfo) {
    // Stale code-split chunk after a deploy → reload once to fetch the new build.
    // If the once-per-session guard blocks the reload (truly broken build), fall
    // through to the error card instead of spinning forever.
    if (isChunkLoadError(error) && !reloadForStaleChunk()) {
      this.setState({ reloading: false });
    }
  }

  render() {
    if (this.state.reloading) {
      return (
        <div className="flex min-h-screen items-center justify-center">
          <Loader2 className="size-6 animate-spin text-muted-foreground" />
        </div>
      );
    }
    if (this.state.hasError) {
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
    return this.props.children;
  }
}
