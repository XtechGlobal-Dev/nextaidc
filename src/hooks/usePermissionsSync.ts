import { useEffect } from "react";
import { useAuthStore } from "@/stores/useAuthStore";
import { isAdminTeamRole } from "@/lib/roles";

const SYNC_MS = 30_000;

/**
 * Keeps a signed-in admin/staff member's cached permissions in sync with the
 * server, so an edit to their role (or a change to which role they're assigned)
 * takes effect without a manual page refresh.
 *
 * The server already authorizes every request against the live `permissions`
 * column — the role editor re-syncs all assigned members the moment it saves.
 * This hook refreshes the *cached* session (`loadMe()`) that drives the sidebar
 * links and per-section gating, on a short interval and whenever the tab regains
 * focus, so switching back to the tab reflects the change near-instantly.
 *
 * Scoped to admin/staff: only their permissions gate the UI, and it avoids the
 * per-`/me` subscription reconciliation a customer poll would trigger. During
 * impersonation the active role is USER, so this naturally pauses.
 */
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
