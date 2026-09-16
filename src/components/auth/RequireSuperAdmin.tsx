import { Navigate } from "react-router-dom";
import type { ReactNode } from "react";
import { useAuthStore } from "@/stores/useAuthStore";
import { isAdminTeamRole, isSuperAdminRole } from "@/lib/roles";

/** Gates platform-owner areas (Brands, Platform Settings, API Center). Brand ADMINs bounce to the admin overview.
 *  Convenience only; the server enforces via `requireSuperAdmin`. */
export function RequireSuperAdmin({ children }: { children: ReactNode }) {
  const user = useAuthStore((s) => s.user);
  const role = user?.role;

  if (!isAdminTeamRole(role)) return <Navigate to="/dashboard" replace />;
  if (!isSuperAdminRole(role)) return <Navigate to="/dashboard/admin/overview" replace />;

  return <>{children}</>;
}
