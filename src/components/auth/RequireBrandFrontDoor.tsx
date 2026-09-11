import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import type { ReactNode } from "react";
import { useAuthStore } from "@/stores/useAuthStore";
import { brandDoor } from "@/lib/brandRoute";
import { frontDoorTarget } from "@/lib/frontDoor";

/**
 * Refuse to send the browser to the same place twice in a row.
 *
 * The redirect below is a full page load, so a disagreement that survives the
 * reload would loop forever. It can happen: a brand suspended mid-session still
 * leaves an authed account naming that brand, while the page can no longer
 * resolve the slug (a suspended brand deliberately stops resolving). Rather than
 * spin, give up after one attempt and let the app render where it is — the
 * session is about to be ended by /me returning 403 anyway.
 */
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

/**
 * Keep a signed-in account on its own front door.
 *
 * A brand has two kinds of door. With PATH routing, `/dashboard` and
 * `/acme/dashboard` are different doors on one host, and an Acme customer on
 * the bare one would be looking at their own data wearing the platform's name,
 * logo and colours — the white label silently not applied. That is fixed by
 * rewriting the path. With HOST routing — `acme.hello22.ai`, or the brand's
 * own domain — the host IS the door: a brand's own user is already home, a
 * platform-level account (the super admin) is allowed in, and another brand's
 * user can only be sent away to their own origin. Which move applies, and
 * whether one is needed at all, is decided by frontDoorTarget().
 *
 * Every redirect here is a FULL page load, not a router navigation, and it has
 * to be: a path prefix is the router's `basename`, fixed when the router was
 * built, and a host change is a different origin altogether. The path, query
 * and hash are carried across so the person lands where they were headed.
 *
 * Deliberately skipped while impersonating: an admin viewing a customer's panel
 * is doing it from the admin's own context, and bouncing them through a reload
 * on the way in and again on the way out would be worse than the mismatch.
 */
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

  // Hold the UI while the browser navigates. Rendering the page underneath
  // would flash the wrong brand's colours for a beat — the exact thing this
  // guard exists to prevent.
  if (target !== null && !gaveUp) {
    return (
      <div className="flex h-screen items-center justify-center text-muted-foreground">
        <Loader2 className="size-6 animate-spin" />
      </div>
    );
  }

  return <>{children}</>;
}
