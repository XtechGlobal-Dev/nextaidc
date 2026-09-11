import { useEffect } from "react";
import { Navigate, useLocation } from "react-router-dom";
import { Loader2 } from "lucide-react";
import { useAuthStore } from "@/stores/useAuthStore";
import type { ReactNode } from "react";

/** Gate dashboard routes — redirects to /login when not authenticated. */
export function RequireAuth({ children }: { children: ReactNode }) {
  const status = useAuthStore((s) => s.status);
  const loadMe = useAuthStore((s) => s.loadMe);
  const location = useLocation();

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

  if (status === "anon") {
    return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  }

  return <>{children}</>;
}
