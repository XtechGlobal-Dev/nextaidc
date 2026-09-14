import { Navigate, useLocation } from "react-router-dom";
import type { ReactNode } from "react";
import { useAuthStore } from "@/stores/useAuthStore";
import {
  adminLandingPath,
  staffLandingPath,
  sectionForPath,
  STAFF_NO_ACCESS_PATH,
} from "@/lib/onboardingRoute";
import { canUseSection, isAdminTeamRole } from "@/lib/roles";

/** Gates admin routes for ADMIN and STAFF; per-section permissions are enforced by the backend. */
export function RequireAdmin({ children }: { children: ReactNode }) {
  // Whole user, so a live permission change from the background sync re-runs this guard.
  const user = useAuthStore((s) => s.user);
  const location = useLocation();
  const role = user?.role;

  if (!isAdminTeamRole(role)) {
    return <Navigate to="/dashboard" replace />;
  }

  // Super admin lives at /superadmin; rewrite old bookmarks so there aren't two URLs for one screen.
  if (role === "SUPER_ADMIN" && location.pathname.startsWith("/dashboard/admin")) {
    return (
      <Navigate
        to={location.pathname.replace("/dashboard/admin", "/superadmin") + location.search}
        replace
      />
    );
  }

  // Brand-only sections the SUPER_ADMIN can't use. Nav hides them; this catches typed URLs. API refuses independently.
  if (
    !canUseSection(role, sectionForPath(location.pathname, role, user?.brandId), user?.brandId)
  ) {
    return <Navigate to={adminLandingPath(user)} replace />;
  }

  // STAFF must sit on a section their role currently grants; a live role edit re-runs this and bounces them.
  if (role === "STAFF" && location.pathname !== STAFF_NO_ACCESS_PATH) {
    const permissions = user?.permissions ?? [];
    const landing = staffLandingPath(permissions);

    // No permitted section at all (permissions cleared, or role unassigned) →
    // the friendly "no access yet" screen.
    if (landing === STAFF_NO_ACCESS_PATH) {
      return <Navigate to={STAFF_NO_ACCESS_PATH} replace />;
    }

    // Section no longer held (just revoked, or ADMIN-only page reached by URL) → first permitted section.
    const section = sectionForPath(location.pathname, role, user?.brandId);
    const holdsSection =
      section !== null && permissions.some((p) => p.startsWith(`${section}.`));
    if (!holdsSection && landing !== location.pathname) {
      return <Navigate to={landing} replace />;
    }
  }

  return <>{children}</>;
}
