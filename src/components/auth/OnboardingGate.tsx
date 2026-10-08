import type { ReactNode } from "react";
import { Navigate } from "react-router-dom";
import { useBrandingStore } from "@/stores/useBrandingStore";

/** Invite-mode brands get a 403 from register, so send them to sign-in first. The platform's own door is open:
 *  each main-domain sign-up gets its own account database. Waits for branding to load since "no brand yet"
 *  and "no brand" look the same. */
export function OnboardingGate({ children }: { children: ReactNode }) {
  const brand = useBrandingStore((s) => s.brand);
  const loaded = useBrandingStore((s) => s.loaded);
  if (!loaded) return null;
  if (brand?.signupMode === "invite") return <Navigate to="/login" replace />;
  return <>{children}</>;
}
