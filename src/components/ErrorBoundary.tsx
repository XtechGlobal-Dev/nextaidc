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

/** Catches render/lazy-import errors. Stale chunk after a deploy reloads once (spinner); anything else gets a Reload card. */
export class ErrorBoundary extends Component<{ children: ReactNode }, State> {
  state: State = { hasError: false, reloading: false };

  static getDerivedStateFromError(error: unknown): State {
    return { hasError: true, reloading: isChunkLoadError(error) };
  }

  componentDidCatch(error: unknown, _info: ErrorInfo) {
    // If the once-per-session reload guard refuses (truly broken build), show the error card instead of spinning forever.
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
