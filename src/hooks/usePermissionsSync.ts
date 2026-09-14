import { useEffect } from "react";
import { useAuthStore } from "@/stores/useAuthStore";
import { isAdminTeamRole } from "@/lib/roles";

const SYNC_MS = 30_000;

/** Re-run loadMe() on an interval + tab focus so a role edit reaches the cached session (sidebar
 *  gating) without a reload. Admin/staff only — a customer poll would trigger /me subscription reconciliation. */
export function usePermissionsSync() {
  const status = useAuthStore((s) => s.status);
  const role = useAuthStore((s) => s.user?.role);
  const isAdminOrStaff = isAdminTeamRole(role);

  useEffect(() => {
    if (status !== "authed" || !isAdminOrStaff) return;
    const refresh = () => void useAuthStore.getState().loadMe();
    const id = window.setInterval(refresh, SYNC_MS);
    const onVisible = () => {
      if (document.visibilityState === "visible") refresh();
    };
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.clearInterval(id);
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [status, isAdminOrStaff]);
}
