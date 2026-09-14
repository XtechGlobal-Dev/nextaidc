import type { Role } from "@prisma/client";

// Role predicates in one place. Ladder: SUPER_ADMIN (platform owner) > ADMIN (one brand, never sees
// platform credentials) > STAFF (permission matrix) > RESELLER / USER (not admin-team).

/** ADMIN or SUPER_ADMIN — anyone who holds full admin rights over their scope. */
export function isAdminRole(role: Role | string | null | undefined): boolean {
  return role === "ADMIN" || role === "SUPER_ADMIN";
}

/** The platform owner. */
export function isSuperAdminRole(role: Role | string | null | undefined): boolean {
  return role === "SUPER_ADMIN";
}

/** Admin team (admin, super admin or staff) — i.e. NOT a customer. */
export function isAdminTeamRole(role: Role | string | null | undefined): boolean {
  return isAdminRole(role) || role === "STAFF";
}

/** Owns a customer workspace (Profile, agent, calls)? No for STAFF and SUPER_ADMIN; ADMIN keeps one for
 *  test calls. Mirror of the client's src/lib/roles.ts. */
export function hasCustomerWorkspace(role: Role | string | null | undefined): boolean {
  return !(role === "STAFF" || role === "SUPER_ADMIN");
}
