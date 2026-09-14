import type { UserRole } from "@/lib/api";

// Role predicates mirroring server/src/lib/roles.ts. Always use these instead of
// comparing to "ADMIN" by hand, or a super admin silently loses the ordinary admin screens.

type Role = UserRole | string | null | undefined;

/** ADMIN or SUPER_ADMIN — full admin rights over whatever they can see. */
export function isAdminRole(role: Role): boolean {
  return role === "ADMIN" || role === "SUPER_ADMIN";
}

/** The platform owner. */
export function isSuperAdminRole(role: Role): boolean {
  return role === "SUPER_ADMIN";
}

/** Anyone on the admin team — admin, super admin or staff (i.e. not a customer). */
export function isAdminTeamRole(role: Role): boolean {
  return isAdminRole(role) || role === "STAFF";
}

/** Owns a customer workspace (dashboard, inbox, AI Brain...)? STAFF have no Profile row so those pages
 *  hang on `profile.id`; SUPER_ADMIN has no business/agent/subscription. ADMIN keeps one for test calls. */
export function hasCustomerWorkspace(role: Role): boolean {
  return !(role === "STAFF" || role === "SUPER_ADMIN");
}

/** Brand-owned sections, refused to the SUPER_ADMIN server-side. Mirrors BRAND_SCOPED_SECTIONS in server/src/lib/permissions.ts. */
export const BRAND_SCOPED_SECTIONS = new Set([
  "overview",
  "customers",
  "subscriptions",
  "voice_bank",
  // A tenant's own customer inbox; the platform owner's inbox is `brand_tickets`.
  "tickets",
  // Brand's own markup and the wallet it lands in; the platform owner manages these from the brand's page.
  "pricing",
  "wallet",
]);

/** Platform-only sections, refused to everyone but the super admin (an audit log a tenant admin can read
 *  is a weak one). Resellers are NOT here: brands run their own. Mirrors server/src/lib/permissions.ts. */
export const PLATFORM_ONLY_SECTIONS = new Set(["audit"]);

/** Sections for the platform's own team (super admin + brand-less staff), never a brand's admin/staff.
 *  Mirrors PLATFORM_TEAM_SECTIONS in server/src/lib/permissions.ts. */
export const PLATFORM_TEAM_SECTIONS = new Set(["brand_tickets"]);

/** Scope rules only; STAFF permission grants are checked separately. `brandId` is null for the
 *  platform's own people and decides which side of the support ladder a STAFF member is on; omit for the brand-side answer. */
export function canUseSection(
  role: Role,
  section: string | null | undefined,
  brandId?: string | null,
): boolean {
  if (!section) return true;
  if (isSuperAdminRole(role)) return !BRAND_SCOPED_SECTIONS.has(section);
  if (PLATFORM_ONLY_SECTIONS.has(section)) return false;
  const platformStaff = role === "STAFF" && brandId === null;
  if (PLATFORM_TEAM_SECTIONS.has(section)) return platformStaff;
  // The platform's own staff work the platform's inbox, never a customer queue.
  if (section === "tickets" && platformStaff) return false;
  return true;
}
