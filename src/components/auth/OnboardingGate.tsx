import type { ReactNode } from "react";
import { Navigate } from "react-router-dom";
import { useBrandingStore } from "@/stores/useBrandingStore";

/**
 * The guided sign-up funnel is a public door — a BRAND's door. A brand that
 * hands out its own accounts has closed it, and the platform's own door was
 * never one: every customer belongs to a brand, so the API refuses the register
 * calls behind both. Send the visitor to sign-in rather than let them fill in
 * five steps that end in a 403. Waits for the branding fetch first, because "no
 * brand yet" and "no brand at all" look the same until it lands.
 */
export function OnboardingGate({ children }: { children: ReactNode }) {
  const brand = useBrandingStore((s) => s.brand);
  const loaded = useBrandingStore((s) => s.loaded);
  if (!loaded) return null;
  if (!brand || brand.signupMode === "invite") return <Navigate to="/login" replace />;
  return <>{children}</>;
}
