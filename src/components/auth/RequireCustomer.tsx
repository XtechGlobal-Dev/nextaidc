import { Navigate } from "react-router-dom";
import type { ReactNode } from "react";
import { useAuthStore } from "@/stores/useAuthStore";
import { adminLandingPath } from "@/lib/onboardingRoute";
import { hasCustomerWorkspace } from "@/lib/roles";

/** Gates the customer workspace. STAFF has no Profile row (pages would hang on a skeleton) and SUPER_ADMIN
 *  has no agent/number/subscription, so both go to the admin area. Catches typed URLs the sidebar hides. */
export function RequireCustomer({ children }: { children: ReactNode }) {
  const user = useAuthStore((s) => s.user);
  if (!hasCustomerWorkspace(user?.role)) {
    return <Navigate to={adminLandingPath(user)} replace />;
  }
  return <>{children}</>;
}
