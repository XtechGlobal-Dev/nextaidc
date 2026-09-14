import type { JwtPayload } from "./jwt.js";

// Tenant scoping for the admin API: platform people (SUPER_ADMIN, brand-less STAFF) see everything,
// everyone else only their brand. Keyed on ROLE too — a brand-less ADMIN used to read as platform-wide.
// Spread into a Prisma `where`: { role: "USER", ...tenantScope(req.user) }.

/** A brand id no row can carry, so a scope built from it matches nothing. */
const NO_BRAND = "__no_brand__";

/** SUPER_ADMIN or brand-less STAFF — the only accounts allowed no brand (migration 0057). */
export function isPlatformAccount(
  user: Pick<JwtPayload, "role" | "brandId"> | undefined,
): boolean {
  return !!user && !user.brandId && (user.role === "SUPER_ADMIN" || user.role === "STAFF");
}

export function tenantScope(user: JwtPayload | undefined): { brandId?: string } {
  if (user?.brandId) return { brandId: user.brandId };
  // A brand-less non-platform account can't exist (DB constraint); if one shows up, match nothing, not everything.
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
