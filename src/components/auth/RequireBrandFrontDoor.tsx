import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import type { ReactNode } from "react";
import { useAuthStore } from "@/stores/useAuthStore";
import { brandDoor } from "@/lib/brandRoute";
import { frontDoorTarget } from "@/lib/frontDoor";

// Loop guard: the redirect is a full page load, and a brand suspended mid-session (slug stops resolving
// while the account still names it) would otherwise bounce forever. Give up after one try; /me will 403 soon.
const ATTEMPT_KEY = "hello22_front_door_redirect";
const ATTEMPT_WINDOW_MS = 10_000;

function recentlyAttempted(target: string): boolean {
  try {
    const raw = sessionStorage.getItem(ATTEMPT_KEY);
    const now = Date.now();
    if (raw) {
      const prev = JSON.parse(raw) as { target: string; at: number };
      if (prev.target === target && now - prev.at < ATTEMPT_WINDOW_MS) return true;
    }
    sessionStorage.setItem(ATTEMPT_KEY, JSON.stringify({ target, at: now }));
  } catch {
    // Private mode / storage disabled — no loop protection, but no crash either.
  }
  return false;
}

/** Keeps a signed-in account on its own brand door (path prefix or host), or the white label silently isn't applied.
 *  Must be a full page load: the path prefix is the router basename and a host change is another origin.
 *  Skipped while impersonating, since the admin is acting from their own context. */
export function RequireBrandFrontDoor({ children }: { children: ReactNode }) {
  const user = useAuthStore((s) => s.user);
  const status = useAuthStore((s) => s.status);
  const impersonating = useAuthStore((s) => s.impersonator !== null);
  // The loop guard tripped: render where we are rather than spin forever.
  const [gaveUp, setGaveUp] = useState(false);

  const door = brandDoor();
  const target =
    status === "authed" && !impersonating && typeof window !== "undefined"
      ? frontDoorTarget({
          accountSlug: user?.brandSlug ?? null,
          accountOrigin: user?.brandOrigin ?? null,
          pageSlug: door?.slug ?? null,
          pageMode: door?.mode ?? "path",
          pageOrigin: window.location.origin,
          pathname: window.location.pathname,
          search: window.location.search,
          hash: window.location.hash,
        })
      : null;

  useEffect(() => {
    if (target === null) return;
    if (recentlyAttempted(target)) {
      setGaveUp(true);
      return;
    }
    window.location.replace(target);
  }, [target]);

  // Hold the UI while navigating, or the wrong brand's colours flash for a beat.
  if (target !== null && !gaveUp) {
    return (
      <div className="flex h-screen items-center justify-center text-muted-foreground">
        <Loader2 className="size-6 animate-spin" />
      </div>
    );
  }

  return <>{children}</>;
}
