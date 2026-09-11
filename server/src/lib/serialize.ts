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
    // The assigned StaffRole's display name (e.g. "Support Agent") so a staff
    // member's own panel can show their role title, not the generic "Staff".
    // Null for admins/customers/resellers or a staff member with no role.
    staffRoleName: user.staffRole?.name ?? null,
    plan: user.profile?.plan ?? "free",
    // The white-label tenant this account belongs to (null = platform-level).
    // The client uses it to tell a brand admin apart from a platform admin —
    // e.g. to label the admin nav with the brand's name.
    brandId: user.brandId ?? null,
    brandName: user.brand?.name ?? null,
    // The brand's address slug. The client needs it to keep a tenant's users
    // inside their own front door: with path routing, `/dashboard` and
    // `/acme/dashboard` are different front doors, and an Acme customer signed
    // in on the bare one would be looking at the platform's branding.
    brandSlug: user.brand?.slug ?? null,
    // Where that brand's users sign in — its verified vanity domain, else its
    // platform subdomain. The client needs it when the page was reached through
    // a brand HOST (acme.hello22.ai) rather than a path prefix: a wrong path can
    // be rewritten in place, but the only way off a wrong host is to leave it.
    brandOrigin: user.brandId ? brandOrigin(cachedBrand(user.brandId)) : null,
    profile: user.profile ?? null,
  };
}
