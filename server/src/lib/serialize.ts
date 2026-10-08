import type { Profile, User } from "@prisma/tenant-client";
import { sanitizePermissions } from "./permissions.js";
import { brandOrigin, cachedBrand, isCustomerBrand } from "../services/brands.js";

/** Shape returned to the client for the authenticated user. */
export function serializeUser(
  user: Pick<User, "id" | "email" | "fullName" | "role" | "permissions"> & {
    profile?: Profile | null;
    staffRole?: { name: string } | null;
    /** The brand the account lives in; null for the platform's own people. */
    brandId?: string | null;
    brand?: { name: string; slug?: string } | null;
  },
) {
  const home = user.brandId ? cachedBrand(user.brandId) : null;
  // A main-domain customer's row has no door of its own: no slug or name to keep them inside.
  const onPlatformDoor = isCustomerBrand(home);
  return {
    id: user.id,
    email: user.email,
    fullName: user.fullName,
    role: user.role,
    // Strip keys for any removed section so the client never sees (or gates on)
    // a permission that's no longer assignable.
    permissions: sanitizePermissions(user.permissions),
    // Role title for the staff member's own panel; null when not staff or no role.
    staffRoleName: user.staffRole?.name ?? null,
    plan: user.profile?.plan ?? "free",
    // null = platform-level; lets the client tell a brand admin from a platform admin.
    brandId: user.brandId ?? null,
    // customer = a main-domain customer (its own row, the platform's door); brand = a white-label brand.
    brandKind: home?.kind ?? null,
    brandName: onPlatformDoor ? null : (user.brand?.name ?? null),
    // Keeps a tenant's users inside their own path front door (`/acme/dashboard`, not `/dashboard`).
    brandSlug: onPlatformDoor ? null : (user.brand?.slug ?? null),
    // Verified vanity domain else platform subdomain — a wrong host can only be left, not rewritten.
    brandOrigin: brandOrigin(home),
    profile: user.profile ?? null,
  };
}
