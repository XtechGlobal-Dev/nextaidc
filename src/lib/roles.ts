import type { UserRole } from "@/lib/api";

/**
 * Role predicates, mirroring server/src/lib/roles.ts so the UI and the API
 * agree on who is what.
 *
 *   SUPER_ADMIN — the platform owner. Everything an ADMIN can do, plus the
 *                 super-admin-only areas: Brands, Platform Settings
 *                 (integration keys / API accounts) and the API Center.
 *   ADMIN       — a brand administrator: their own tenant, nothing else.
 *   STAFF       — admin-team member gated by a permission matrix.
 *
 * Always go through these rather than comparing to "ADMIN" by hand, or a super
 * admin silently loses access to the ordinary admin screens.
 */

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

/**
 * Does this role own a customer workspace — the Dashboard, Call Inbox, AI Brain,
 * CRM, Booking and the rest of the "user side"?
 *
 * No for STAFF and SUPER_ADMIN, and for two different reasons that land in the
 * same place:
 *   • STAFF are admin-team members with no Profile row, so those pages would
 *     hang forever on a skeleton that waits for `profile.id`.
 *   • SUPER_ADMIN runs the platform. They have no business, no agent and no
 *     subscription, so a receptionist workspace is meaningless to them — and
 *     showing it invites them to create customer state that shouldn't exist.
 *
 * ADMIN keeps its workspace: a brand admin still gets a real profile and agent
 * so they can place test calls through their own tenant.
 */
export function hasCustomerWorkspace(role: Role): boolean {
  return !(role === "STAFF" || role === "SUPER_ADMIN");
}

/**
 * Sections that belong to a BRAND, not to the platform — mirrors
 * BRAND_SCOPED_SECTIONS in server/src/lib/permissions.ts.
 *
 * The tenant's own customer base: its signup metrics, its customers, their
 * subscriptions and the voices they may pick from. A brand admin runs those;
 * the SUPER_ADMIN runs the platform (brands, plans, the number pool, providers,
 * settings) and is refused them by `requirePermission` on the server.
 */
export const BRAND_SCOPED_SECTIONS = new Set([
  "overview",
  "customers",
  "subscriptions",
  "voice_bank",
  // A tenant's customers talking to that tenant's own team — its customer
  // list in conversation form, so the same rule applies. The platform owner's
  // own inbox is `brand_tickets` below.
  "tickets",
  // A brand's own charge on top of the platform's plans, and the wallet its
  // share lands in. The platform owner manages these FROM the brand's page.
  "pricing",
  "wallet",
]);

/**
 * Sections that belong to the PLATFORM, not to any one brand — mirrors
 * PLATFORM_ONLY_SECTIONS in server/src/lib/permissions.ts.
 *
 * The audit trail is the platform owner's: an audit log a tenant's own admin
 * can read is a weak audit log. The exact mirror image of BRAND_SCOPED_SECTIONS
 * above — that set is refused to the super admin, this one is refused to
 * everyone else.
 *
 * The reseller/affiliate programme used to sit here too. It no longer does: a
 * brand recruits and pays its own resellers, so every ADMIN sees the section,
 * scoped to their own tenant by the server. It is still absent from the staff
 * permission matrix, so STAFF cannot be granted it.
 */
export const PLATFORM_ONLY_SECTIONS = new Set(["audit"]);

/**
 * Sections worked by the platform's own TEAM — mirrors PLATFORM_TEAM_SECTIONS
 * in server/src/lib/permissions.ts.
 *
 * The requests brand admins raise with the platform. One brand's query is
 * between that brand and the platform, so the super admin has it, and so do
 * the support staff they employ — the accounts with no brand. A brand's admin
 * or staff never do.
 */
export const PLATFORM_TEAM_SECTIONS = new Set(["brand_tickets"]);

/**
 * May this account use an admin section? Only the scope rules live here — a
 * STAFF member's own permission grants are checked separately.
 *
 * `brandId` is the account's tenant: null for the platform's own people (the
 * super admin, and platform staff), a brand id for everyone else. It decides
 * which side of the support ladder a STAFF member is on. Callers that don't
 * know it may leave it out and get the brand-side answer.
 */
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
