import { useEffect } from "react";
import { Navigate } from "react-router-dom";
import { Loader2 } from "lucide-react";
import { useAuthStore } from "@/stores/useAuthStore";
import { onboardingRedirectPath } from "@/lib/onboardingRoute";
import type { ReactNode } from "react";

/** Public routes that bounce authenticated users on — to the dashboard, or back
 *  into onboarding if they haven't finished it yet. */
export function RedirectIfAuthed({ children }: { children: ReactNode }) {
  const status = useAuthStore((s) => s.status);
  const user = useAuthStore((s) => s.user);
  const loadMe = useAuthStore((s) => s.loadMe);

  useEffect(() => {
    if (status === "idle") void loadMe();
  }, [status, loadMe]);

  if (status === "idle" || status === "loading") {
    return (
      <div className="flex h-screen items-center justify-center text-muted-foreground">
        <Loader2 className="size-6 animate-spin" />
      </div>
    );
  }

  if (status === "authed") {
    return <Navigate to={onboardingRedirectPath(user)} replace />;
  }

  return <>{children}</>;
}
