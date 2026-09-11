import { Navigate } from "react-router-dom";
import type { ReactNode } from "react";
import { useAuthStore } from "@/stores/useAuthStore";
import { adminLandingPath } from "@/lib/onboardingRoute";
import { hasCustomerWorkspace } from "@/lib/roles";

/**
 * Gate the customer workspace (Dashboard, Call Inbox, AI Brain, Connect CRM,
 * Plans, Forwarding, Transfer, Booking, SMS to Caller).
 *
 * Two roles have no such workspace and are redirected to the admin area:
 *   • STAFF — no Profile row, so these pages would hang forever on a skeleton
 *     that waits for `profile.id`.
 *   • SUPER_ADMIN — runs the platform, not a business on it. They have no agent,
 *     no number and no subscription, so every one of these screens would be
 *     empty at best and would invite creating customer state at worst.
 *
 * ADMIN and USER pass through — both own a real profile.
 *
 * This is the guard, not just decoration: the sidebar hides these entries, but
 * a typed URL or an old bookmark has to land somewhere sensible too.
 */
export function RequireCustomer({ children }: { children: ReactNode }) {
  const user = useAuthStore((s) => s.user);
  if (!hasCustomerWorkspace(user?.role)) {
    return <Navigate to={adminLandingPath(user)} replace />;
  }
  return <>{children}</>;
}
