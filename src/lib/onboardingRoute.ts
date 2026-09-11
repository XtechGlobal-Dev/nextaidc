import type { AuthUser } from "@/lib/api";
import { cardWallActive } from "@/lib/cardWall";
import { canUseSection, hasCustomerWorkspace } from "@/lib/roles";

/** Onboarding step the user resumes at for the pricing/subscribe screen. */
export const ONBOARDING_PRICING_STEP = 8;

/** Where a STAFF member with no permitted section is sent — a friendly
 *  "no access yet" screen (see StaffNoAccessPage). */
export const STAFF_NO_ACCESS_PATH = "/dashboard/no-access";

// Staff-assignable sections → their landing route, in priority order (the first
// one a staff member holds is where they land). Admin-only areas (staff, roles,
// reports, webhooks, health, settings) are intentionally absent — staff can't be
// granted them, so they can never land there.
const SECTION_ROUTES: Record<string, string> = {
  overview: "/dashboard/admin/overview",
  customers: "/dashboard/admin/customers",
  subscriptions: "/dashboard/admin/subscriptions",
  plans: "/dashboard/admin/plans",
  coupons: "/dashboard/admin/coupons",
  // Both handler inboxes live at the same path under their own prefix — which
  // is the same page, resolving its lane from the caller's role.
  tickets: "/dashboard/admin/tickets",
  brand_tickets: "/dashboard/admin/tickets",
  voice_bank: "/dashboard/admin/voice-bank",
  phone_numbers: "/dashboard/admin/phone-numbers",
  resellers: "/dashboard/admin/resellers",
  emails: "/dashboard/admin/emails",
  audit: "/dashboard/admin/audit",
};

/**
 * Where a member of the admin team lands — the one place to ask "this account
 * has no customer workspace, so what do they see instead?".
 *
 * The SUPER_ADMIN holds no permission keys (they bypass the matrix entirely), so
 * running them through `staffLandingPath` would strand them on the staff
 * "no access yet" screen. They own every panel, so they land on the overview.
 */
/** Where the admin panel lives for this account. Same pages either way — the
 *  platform owner just gets their own URL space (see adminRoutes in App.tsx). */
export function adminBaseFor(role: string | null | undefined): string {
  return role === "SUPER_ADMIN" ? "/superadmin" : "/dashboard/admin";
}

/** Rewrite a canonical `/dashboard/admin/...` path onto the caller's own base,
 *  so one nav definition serves both prefixes. */
export function adminHref(path: string, role: string | null | undefined): string {
  return path.replace("/dashboard/admin", adminBaseFor(role));
}

export function adminLandingPath(user: AuthUser | null): string {
  // The platform overview is the super admin's home: the brand Overview is a
  // brand-scoped section they don't hold, and they carry no permission keys at
  // all (they bypass the matrix), so running them through staffLandingPath
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

/**
 * EVERY staff-assignable section served at an admin pathname.
 *
 * Almost always one. The exception is the handler inbox: `tickets` and
 * `brand_tickets` are one page under one path, resolving its lane from the
 * caller's role, so the path alone cannot say which of the two it is — only who
 * is asking can. Callers that need a single answer go through sectionForPath.
 */
export function sectionsForPath(pathname: string): string[] {
  // The same panel is served under two prefixes; normalise to the canonical one
  // so a rule written once covers both.
  const path = pathname.startsWith("/superadmin")
    ? pathname.replace("/superadmin", "/dashboard/admin")
    : pathname;
  return Object.entries(SECTION_ROUTES)
    .filter(([, route]) => path === route || path.startsWith(`${route}/`))
    .map(([key]) => key);
}

/**
 * Which staff-assignable section an admin pathname belongs to for THIS account —
 * e.g. "/dashboard/admin/customers/123" → "customers". Returns null when the
 * path isn't a staff-assignable section (an ADMIN-only page like settings/roles,
 * or anything outside the admin area). Used to bounce a STAFF member off a panel
 * the moment their role loses that section.
 *
 * `role` and `brandId` only matter where one path serves two sections — see
 * sectionsForPath.
 */
export function sectionForPath(
  pathname: string,
  role?: string | null,
  brandId?: string | null,
): string | null {
  const keys = sectionsForPath(pathname);
  if (keys.length <= 1) return keys[0] ?? null;
  // Ambiguous path — pick the section this account actually holds. Falling back
  // to the first key would answer "tickets" for the platform's own people, whom
  // that section is refused, and RequireAdmin would bounce them off their own
  // inbox.
  return keys.find((key) => canUseSection(role, key, brandId)) ?? keys[0];
}

export function onboardingRedirectPath(user: AuthUser | null): string {
  // Accounts with no customer workspace (STAFF, SUPER_ADMIN) go straight to the
  // admin area — never to a customer page like the dashboard or AI Brain, which
  // would hang forever waiting for a profile they don't have.
  if (!hasCustomerWorkspace(user?.role)) return adminLandingPath(user);
  const profile = user?.profile;
  if (!profile) return "/dashboard";
  const step = profile.onboardingStep ?? 0;
  // Card required at signup and no card yet → the plan/card screen is the only
  // place they can go. This has to be decided BEFORE the onboardingCompletedAt
  // check below: a direct (non-funnel) signup is stamped complete at creation, so
  // onboarding state alone could never hold this wall.
  // The one exception is a guided-funnel signup still mid-flow — it finishes
  // Services/Overview first (exactly as the old pricing wall did), and Step7Finish
  // then parks it on ONBOARDING_PRICING_STEP so the next login lands here.
  if (cardWallActive(user)) {
    const midFunnel =
      !profile.onboardingCompletedAt && step >= 5 && step < ONBOARDING_PRICING_STEP;
    return midFunnel ? "/onboarding" : "/subscribe";
  }
  if (profile.onboardingCompletedAt) return "/dashboard";
  // No plan/card wall for a card-less signup — onboarding finishes at the Overview
  // step and the dashboard is always reachable. A user still mid-funnel (paused on
  // Services/Overview) resumes the guided flow; anyone past it lands on the
  // dashboard, where the "tap to set up" wizard collects plan + card if/when they
  // claim a number.
  if (step >= 5 && step < ONBOARDING_PRICING_STEP) return "/onboarding";
  return "/dashboard";
}
