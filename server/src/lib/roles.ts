import type { Role } from "@prisma/client";

/**
 * Role predicates, in one place, so "who counts as an admin?" is answered the
 * same way by every route.
 *
 * The ladder:
 *   SUPER_ADMIN — the platform owner. Passes every ADMIN check, plus the
 *                 super-admin-only areas: Brands, Platform Settings
 *                 (integration keys / API accounts) and the API Center.
 *   ADMIN       — a brand administrator. Runs one tenant and everything inside
 *                 it, but never sees platform integration credentials.
 *   STAFF       — an admin-team member with a permission matrix.
 *   RESELLER / USER — not admin-team at all.
 */

/** ADMIN or SUPER_ADMIN — anyone who holds full admin rights over their scope. */
export function isAdminRole(role: Role | string | null | undefined): boolean {
  return role === "ADMIN" || role === "SUPER_ADMIN";
}

/** The platform owner. */
export function isSuperAdminRole(role: Role | string | null | undefined): boolean {
  return role === "SUPER_ADMIN";
}

/**
 * Anyone on the admin team (admin, super admin or staff) — i.e. NOT a customer.
 * Used wherever an operation only makes sense on a customer account
 * ("you can't suspend a staff member", "admins have no subscription").
 */
export function isAdminTeamRole(role: Role | string | null | undefined): boolean {
  return isAdminRole(role) || role === "STAFF";
}

/**
 * Does this role own a customer workspace — a Profile, an AI agent, calls, a
 * CRM connection, a subscription?
 *
 * No for STAFF (admin-team members who never had a Profile row) and no for
 * SUPER_ADMIN (runs the platform rather than a business on it). ADMIN keeps
 * one: a brand admin gets a real profile and agent so they can place test calls
 * through their own tenant.
 *
 * The mirror of hasCustomerWorkspace in src/lib/roles.ts on the client — the UI
 * hides these areas, `requireCustomerAccount` is what actually refuses them.
 */
export function hasCustomerWorkspace(role: Role | string | null | undefined): boolean {
  return !(role === "STAFF" || role === "SUPER_ADMIN");
}
