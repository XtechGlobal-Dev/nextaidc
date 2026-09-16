import type { AuthUser } from "@/lib/api";
import { cardWallActive } from "@/lib/cardWall";
import { canUseSection, hasCustomerWorkspace } from "@/lib/roles";

/** Onboarding step the user resumes at for the pricing/subscribe screen. */
export const ONBOARDING_PRICING_STEP = 8;

/** Where a STAFF member with no permitted section is sent — a friendly
 *  "no access yet" screen (see StaffNoAccessPage). */
export const STAFF_NO_ACCESS_PATH = "/dashboard/no-access";

// Staff-assignable sections -> landing route, in priority order. Admin-only areas
// are deliberately absent: staff can't be granted them, so they can never land there.
const SECTION_ROUTES: Record<string, string> = {
  overview: "/dashboard/admin/overview",
  customers: "/dashboard/admin/customers",
  subscriptions: "/dashboard/admin/subscriptions",
  plans: "/dashboard/admin/plans",
  coupons: "/dashboard/admin/coupons",
  // Both inboxes are one page at one path; it picks its lane from the caller's role.
  tickets: "/dashboard/admin/tickets",
  brand_tickets: "/dashboard/admin/tickets",
  voice_bank: "/dashboard/admin/voice-bank",
  phone_numbers: "/dashboard/admin/phone-numbers",
  resellers: "/dashboard/admin/resellers",
  emails: "/dashboard/admin/emails",
  audit: "/dashboard/admin/audit",
};

/** Admin panel base for this account; same pages, the platform owner just gets its own URL space (see adminRoutes in App.tsx). */
export function adminBaseFor(role: string | null | undefined): string {
  return role === "SUPER_ADMIN" ? "/superadmin" : "/dashboard/admin";
}

/** Rewrite a canonical `/dashboard/admin/...` path onto the caller's own base,
 *  so one nav definition serves both prefixes. */
export function adminHref(path: string, role: string | null | undefined): string {
  return path.replace("/dashboard/admin", adminBaseFor(role));
}

export function adminLandingPath(user: AuthUser | null): string {
  // Super admin holds no permission keys (bypasses the matrix), so staffLandingPath
  // would strand them on the "no access yet" screen.
  if (user?.role === "SUPER_ADMIN") return "/superadmin/platform";
  return staffLandingPath(user?.permissions ?? []);
}

export function staffLandingPath(permissions: string[]): string {
  for (const key of Object.keys(SECTION_ROUTES)) {
    if (permissions.some((p) => p.startsWith(`${key}.`))) return SECTION_ROUTES[key];
  }
  // No permitted section — a role with nothing ticked, or no role assigned yet.
  return STAFF_NO_ACCESS_PATH;
}

/** Every staff-assignable section at an admin pathname. Usually one; `tickets` and `brand_tickets`
 *  share a path and only the caller's role tells them apart, so use sectionForPath for a single answer. */
export function sectionsForPath(pathname: string): string[] {
  // Normalise the /superadmin prefix so one rule covers both URL spaces.
  const path = pathname.startsWith("/superadmin")
    ? pathname.replace("/superadmin", "/dashboard/admin")
    : pathname;
  return Object.entries(SECTION_ROUTES)
    .filter(([, route]) => path === route || path.startsWith(`${route}/`))
    .map(([key]) => key);
}

/** Staff-assignable section for an admin pathname, or null when it isn't one (ADMIN-only pages, outside
 *  the admin area). `role`/`brandId` only matter where one path serves two sections. */
export function sectionForPath(
  pathname: string,
  role?: string | null,
  brandId?: string | null,
): string | null {
  const keys = sectionsForPath(pathname);
  if (keys.length <= 1) return keys[0] ?? null;
  // Ambiguous path: pick the section this account holds, or RequireAdmin would
  // bounce platform staff off their own inbox by answering "tickets".
  return keys.find((key) => canUseSection(role, key, brandId)) ?? keys[0];
}

export function onboardingRedirectPath(user: AuthUser | null): string {
  // STAFF/SUPER_ADMIN have no profile; a customer page would hang forever waiting for one.
  if (!hasCustomerWorkspace(user?.role)) return adminLandingPath(user);
  const profile = user?.profile;
  if (!profile) return "/dashboard";
  const step = profile.onboardingStep ?? 0;
  // Card wall must be checked BEFORE onboardingCompletedAt: direct signups are stamped complete
  // at creation. Exception: a guided-funnel signup mid-flow finishes Services/Overview first.
  if (cardWallActive(user)) {
    const midFunnel =
      !profile.onboardingCompletedAt && step >= 5 && step < ONBOARDING_PRICING_STEP;
    return midFunnel ? "/onboarding" : "/subscribe";
  }
  if (profile.onboardingCompletedAt) return "/dashboard";
  // No wall for a card-less signup: mid-funnel resumes the guided flow, everyone else
  // gets the dashboard, where the quick-setup wizard collects plan + card on number claim.
  if (step >= 5 && step < ONBOARDING_PRICING_STEP) return "/onboarding";
  return "/dashboard";
}
