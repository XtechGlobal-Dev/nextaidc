import type { Profile, User } from "@prisma/tenant-client";
import { sanitizePermissions } from "./permissions.js";
import { brandOrigin, cachedBrand } from "../services/brands.js";

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
    brandName: user.brand?.name ?? null,
    // Keeps a tenant's users inside their own path front door (`/acme/dashboard`, not `/dashboard`).
    brandSlug: user.brand?.slug ?? null,
    // Verified vanity domain else platform subdomain — a wrong host can only be left, not rewritten.
    brandOrigin: user.brandId ? brandOrigin(cachedBrand(user.brandId)) : null,
    profile: user.profile ?? null,
  };
}
