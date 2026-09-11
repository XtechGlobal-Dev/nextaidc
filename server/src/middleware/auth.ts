import type { NextFunction, Request, Response } from "express";
import { verifyToken, type JwtPayload } from "../lib/jwt.js";
import { unauthorized, forbidden, HttpError } from "../lib/http.js";
import { prisma } from "../prisma.js";
import { tenantFor, TenantUnavailableError } from "../services/tenantDb.js";
import type { Capability } from "../lib/permissions.js";
import {
  BRAND_SCOPED_SECTIONS,
  PLATFORM_ONLY_SECTIONS,
  PLATFORM_TEAM_SECTIONS,
  sanitizePermissions,
  scopePermissionsToTenant,
} from "../lib/permissions.js";
import {
  hasCustomerWorkspace,
  isAdminRole,
  isAdminTeamRole,
  isSuperAdminRole,
} from "../lib/roles.js";
import { setCurrentBrandId } from "../lib/brandContext.js";

// Augment Express Request with the authenticated user.
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: JwtPayload;
    }
  }
}

function extractToken(req: Request): string | null {
  const header = req.headers.authorization;
  if (header?.startsWith("Bearer ")) return header.slice(7);
  return null;
}

/**
 * Require a valid JWT AND that the user still exists in the DB.
 * (A stateless token alone stays valid after a user is deleted/disabled;
 * the DB check forces those sessions to fail immediately with 401.)
 */
export async function requireAuth(req: Request, _res: Response, next: NextFunction) {
  const token = extractToken(req);
  if (!token) return next(unauthorized("Missing bearer token"));

  let payload: JwtPayload;
  try {
    payload = verifyToken(token);
  } catch {
    return next(unauthorized("Invalid or expired token"));
  }

  try {
    const user = await loadSessionIdentity(payload);
    if (!user) return next(unauthorized("Account no longer exists"));
    // Use the live row (role/email stay fresh, not whatever the token baked in).
    // Sanitize so keys for any removed section can never authorize, even if an
    // old role/user row still has them stored.
    req.user = {
      sub: user.id,
      email: user.email,
      role: user.role,
      // Then narrowed to the side of the support ladder this account is on: a
      // brand's staff can't hold the platform inbox's keys, nor the platform's
      // staff a customer queue's.
      permissions: scopePermissionsToTenant(sanitizePermissions(user.permissions), user.brandId),
      // Tenant the account belongs to (null = the platform's own people: the
      // SUPER_ADMIN and the staff they employ). Read live rather than from the
      // token so moving an account between brands takes effect on the next
      // request, not the next login.
      brandId: user.brandId ?? null,
    };
    // Now that we know WHO is calling, their own tenant beats whatever host the
    // request came in on — an Acme admin working from the platform domain still
    // sends as Acme. A platform-level account (brandId null) leaves the
    // host-resolved brand alone, so a super admin helping inside a brand's
    // subdomain keeps that brand's context.
    if (user.brandId) setCurrentBrandId(user.brandId);
    next();
  } catch (err) {
    if (err instanceof TenantUnavailableError) {
      // The brand's database is mid-migration or paused: nobody in that brand
      // can be served, and the session is not at fault. Say so, without
      // logging anyone out.
      return next(
        new HttpError(503, "This brand's database isn't available right now. Try again shortly.", "brand_not_ready"),
      );
    }
    next(err);
  }
}

const IDENTITY_SELECT = { id: true, email: true, role: true, permissions: true } as const;

/**
 * The live account behind a token, read from the plane the token names.
 *
 * A brand account (`brandId` set) is read from the brand's own database —
 * that is where its people live. A platform account (`brandId` null) is read
 * from the control plane — the only accounts there (phase 6). A token minted
 * before tokens carried `brandId` names no plane, so a brand account holding
 * one is simply signed out and signs in again.
 */
async function loadSessionIdentity(
  payload: JwtPayload,
): Promise<{ id: string; email: string; role: JwtPayload["role"]; permissions: string[]; brandId: string | null } | null> {
  if (payload.brandId) {
    const tenant = await tenantFor(payload.brandId);
    const row = await tenant.user.findUnique({ where: { id: payload.sub }, select: IDENTITY_SELECT });
    return row ? { ...row, brandId: payload.brandId } : null;
  }
  // No brand named: the platform's own people, who live here and nowhere else.
  const row = await prisma.user.findUnique({ where: { id: payload.sub }, select: IDENTITY_SELECT });
  return row ? { ...row, brandId: null } : null;
}

/** Require a full admin — ADMIN or SUPER_ADMIN (strict: STAFF does not pass). */
export function requireAdmin(req: Request, _res: Response, next: NextFunction) {
  if (!req.user) return next(unauthorized());
  if (!isAdminRole(req.user.role)) return next(forbidden("Admin access required"));
  next();
}

/**
 * Require the platform owner. Gates everything a brand admin must NOT reach:
 * the Brands panel, Platform Settings (integration keys / API accounts) and the
 * API Center. Kept separate from requireAdmin on purpose — a brand ADMIN runs
 * their own tenant but never holds the platform's provider credentials.
 */
export function requireSuperAdmin(req: Request, _res: Response, next: NextFunction) {
  if (!req.user) return next(unauthorized());
  if (!isSuperAdminRole(req.user.role)) {
    return next(forbidden("Super admin access required"));
  }
  next();
}

/** Require an admin-team member — ADMIN, SUPER_ADMIN or STAFF (gates the admin area). */
export function requireAdminOrStaff(req: Request, _res: Response, next: NextFunction) {
  if (!req.user) return next(unauthorized());
  if (!isAdminTeamRole(req.user.role)) {
    return next(forbidden("Admin access required"));
  }
  next();
}

/**
 * Require a specific section + capability. ADMINs always pass; STAFF must
 * have the `section.capability` key in their `permissions` array.
 *
 * Usage: requirePermission("customers", "view")
 *        requirePermission("customers", "delete")
 *        requirePermission("settings")  // defaults to "view"
 */
export function requirePermission(section: string, capability: Capability = "view") {
  const key = `${section}.${capability}`;
  return (req: Request, _res: Response, next: NextFunction) => {
    if (!req.user) return next(unauthorized());
    // The platform owner outranks every permission — except on the sections that
    // belong to a brand rather than to the platform. Those are the tenant's own
    // customer base, and running them is the brand admin's job.
    if (isSuperAdminRole(req.user.role)) {
      if (BRAND_SCOPED_SECTIONS.has(section)) {
        return next(forbidden("This section belongs to a brand, not the platform."));
      }
      return next();
    }
    // The other direction: sections that belong to the platform rather than to
    // any one brand. The super admin passed above; nobody else gets these.
    if (PLATFORM_ONLY_SECTIONS.has(section)) {
      return next(forbidden("This section belongs to the platform, not a brand."));
    }
    // The platform's own team: staff with no brand, holding the key. A brand's
    // admin or staff is refused outright — it is not their inbox.
    if (PLATFORM_TEAM_SECTIONS.has(section)) {
      if (!req.user.brandId && req.user.role === "STAFF" && req.user.permissions.includes(key)) {
        return next();
      }
      return next(forbidden("This section belongs to the platform, not a brand."));
    }
    if (isAdminRole(req.user.role)) return next();
    if (req.user.role === "STAFF" && req.user.permissions.includes(key)) {
      return next();
    }
    next(forbidden("You don't have permission to access this section"));
  };
}

/**
 * Require an account that actually owns a customer workspace.
 *
 * Gates the customer-facing feature APIs — the AI Brain, call inbox, CRM, human
 * transfer, booking and trial — against the two roles that have no business of
 * their own: STAFF and SUPER_ADMIN. For them these endpoints have nothing to
 * read, and a write would mint customer state (a Profile, a Conversion, a
 * provisioned agent) for an account that should never hold any.
 *
 * The UI hides these areas already; this is the part that refuses them.
 * Must run after `requireAuth`.
 */
export function requireCustomerAccount(req: Request, _res: Response, next: NextFunction) {
  if (!req.user) return next(unauthorized());
  if (!hasCustomerWorkspace(req.user.role)) {
    return next(forbidden("This area is for customer accounts."));
  }
  next();
}

/** Require an authenticated RESELLER user. */
export function requireReseller(req: Request, _res: Response, next: NextFunction) {
  if (!req.user) return next(unauthorized());
  if (req.user.role !== "RESELLER") return next(forbidden("Reseller access required"));
  next();
}
