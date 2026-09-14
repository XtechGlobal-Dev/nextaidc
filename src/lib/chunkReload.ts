// Self-healing for stale hashed chunks after a deploy: a stale index.html fails to import() a lazy route and
// blanks the app, so reload ONCE (loop-guarded); a truly broken build falls through to the ErrorBoundary.

const RELOAD_FLAG = "hello22:chunk-reloaded";

/** Heuristic: a stale dynamic-import / chunk-load failure (post-deploy). */
export function isChunkLoadError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err ?? "");
  return /dynamically imported module|module script failed|chunkloaderror|loading chunk [\d]+ failed|failed to fetch dynamically/i.test(
    msg,
  );
}

/** Reload once to fetch the fresh index.html + chunks. Guarded so a truly broken
 *  build can't loop. Returns true if it triggered a reload. */
export function reloadForStaleChunk(): boolean {
  try {
    if (sessionStorage.getItem(RELOAD_FLAG)) return false; // already retried this session
    sessionStorage.setItem(RELOAD_FLAG, "1");
  } catch {
    /* sessionStorage blocked (private mode) — still attempt a single reload */
  }
  window.location.reload();
  return true;
}

/** Clear the guard once the app mounts cleanly, so a LATER deploy can self-heal
 *  again (each successful load resets the one-reload budget). */
export function clearChunkReloadGuard(): void {
  try {
    sessionStorage.removeItem(RELOAD_FLAG);
  } catch {
    /* ignore */
  }
}

/** Clear the boot-watchdog guard set by the inline script in index.html (key must match) so a later failed boot can self-heal. */
export function clearBootReloadGuard(): void {
  try {
    sessionStorage.removeItem("hello22:boot-reloaded");
  } catch {
    /* ignore */
  }
}

/** Vite fires `vite:preloadError` when a lazy-import preload 404s (stale chunk).
 *  Catch it and reload once instead of letting it blank the screen. */
export function installChunkReloadHandler(): void {
  window.addEventListener("vite:preloadError", (e) => {
    e.preventDefault();
    reloadForStaleChunk();
  });
}
