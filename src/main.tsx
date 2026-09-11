import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { AppToaster } from "@/components/ui/AppToaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { App } from "@/App";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { installChunkReloadHandler } from "@/lib/chunkReload";
import "@/index.css";

// Self-heal stale lazy-chunk loads after a deploy (avoids blank white screens).
installChunkReloadHandler();

const queryClient = new QueryClient({
  defaultOptions: { queries: { staleTime: 30_000, refetchOnWindowFocus: false } },
});

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ErrorBoundary>
      <QueryClientProvider client={queryClient}>
        <TooltipProvider delayDuration={200}>
          <App />
          <AppToaster />
        </TooltipProvider>
      </QueryClientProvider>
    </ErrorBoundary>
  </StrictMode>,
);
