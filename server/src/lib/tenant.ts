import type { JwtPayload } from "./jwt.js";

/**
 * Tenant scoping for the admin API.
 *
 * The rule, in one sentence: **the platform's own people see everything;
 * everyone else sees only their own brand.**
 *
 * "The platform's own people" are the SUPER_ADMIN and the support STAFF they
 * employ — the only accounts allowed to have no brand. Every other account
 * belongs to a brand; the database enforces it (migration 0057). So the scope
 * is keyed on the ROLE as well as the column: an ADMIN, USER or RESELLER that
 * somehow has no brand must see nothing, not everything. That was the leak
 * this replaces — an ADMIN with no brand used to read as platform-wide.
 *
 * Spread the result into a Prisma `where` on a table that carries `brandId`:
 *
 *   where: { role: "USER", ...tenantScope(req.user) }
 *
 * For tables one hop away (profiles, calls) go through the relation:
 *
 *   where: { user: { role: "USER", ...tenantScope(req.user) } }
 */

/** A brand id no row can carry, so a scope built from it matches nothing. */
const NO_BRAND = "__no_brand__";

/**
 * True for an account that belongs to the platform itself rather than to a
 * brand: the SUPER_ADMIN, or STAFF the super admin employs. These are the only
 * accounts that may have no brand (migration 0057); a brand's own staff carry
 * their brand and are NOT platform accounts.
 */
export function isPlatformAccount(
  user: Pick<JwtPayload, "role" | "brandId"> | undefined,
): boolean {
  return !!user && !user.brandId && (user.role === "SUPER_ADMIN" || user.role === "STAFF");
}

export function tenantScope(user: JwtPayload | undefined): { brandId?: string } {
  if (user?.brandId) return { brandId: user.brandId };
  // No brand: platform-wide for the platform's own people. Anyone else with
  // no brand cannot exist (the constraint refuses the row) — if one is ever
  // reached anyway, match nothing rather than everything.
  return isPlatformAccount(user) ? {} : { brandId: NO_BRAND };
}

/** True when this admin may act on a record belonging to `brandId`. */
export function canReachBrand(
  user: JwtPayload | undefined,
  brandId: string | null | undefined,
): boolean {
  if (isPlatformAccount(user)) return true; // no tenant walls
  return !!user?.brandId && user.brandId === brandId;
}
