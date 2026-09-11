import { Navigate } from "react-router-dom";
import type { ReactNode } from "react";
import { useAuthStore } from "@/stores/useAuthStore";
import { isAdminTeamRole, isSuperAdminRole } from "@/lib/roles";

/**
 * Gate the platform-owner areas: Brands, Platform Settings (integration keys /
 * API accounts) and the API Center.
 *
 * A brand ADMIN runs their own tenant but must never reach the platform's
 * provider credentials, so they're bounced to the admin overview rather than
 * shown an empty panel. Anyone who isn't admin-team at all goes to the
 * customer dashboard, matching RequireAdmin.
 *
 * This is convenience, not the boundary — every route behind it is enforced
 * server-side by `requireSuperAdmin`.
 */
export function RequireSuperAdmin({ children }: { children: ReactNode }) {
  const user = useAuthStore((s) => s.user);
  const role = user?.role;

  if (!isAdminTeamRole(role)) return <Navigate to="/dashboard" replace />;
  if (!isSuperAdminRole(role)) return <Navigate to="/dashboard/admin/overview" replace />;

  return <>{children}</>;
}
