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

/** Valid JWT AND the user still exists — a stateless token alone outlives a deleted/disabled account. */
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
    // Live row, not the token: role/email stay fresh and orphaned keys for removed sections can't authorize.
    req.user = {
      sub: user.id,
      email: user.email,
      role: user.role,
      // Narrowed to this account's side of the ladder — brand staff never hold platform-inbox keys and vice versa.
      permissions: scopePermissionsToTenant(sanitizePermissions(user.permissions), user.brandId),
      // null = platform's own people. Read live so moving an account between brands applies next request.
      brandId: user.brandId ?? null,
    };
    // The caller's own tenant beats the request host. A platform account (null) leaves the host-resolved
    // brand alone so a super admin inside a brand subdomain keeps that context.
    if (user.brandId) setCurrentBrandId(user.brandId);
    next();
  } catch (err) {
    if (err instanceof TenantUnavailableError) {
      // Brand DB mid-migration or paused — the session isn't at fault, so don't log anyone out.
      return next(
        new HttpError(503, "This brand's database isn't available right now. Try again shortly.", "brand_not_ready"),
      );
    }
    next(err);
  }
}

const IDENTITY_SELECT = { id: true, email: true, role: true, permissions: true } as const;

// Brand accounts live in the brand's DB, platform accounts in the control plane. A pre-brandId
// token from a brand account just fails and the user signs in again.
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

/** Platform owner only. Separate from requireAdmin — a brand ADMIN never holds the platform's provider credentials. */
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

/** Require `section.capability`. ADMINs pass; STAFF need the key in `permissions`. */
export function requirePermission(section: string, capability: Capability = "view") {
  const key = `${section}.${capability}`;
  return (req: Request, _res: Response, next: NextFunction) => {
    if (!req.user) return next(unauthorized());
    // Super admin outranks everything except brand-scoped sections — a tenant's customer base is the brand admin's.
    if (isSuperAdminRole(req.user.role)) {
      if (BRAND_SCOPED_SECTIONS.has(section)) {
        return next(forbidden("This section belongs to a brand, not the platform."));
      }
      return next();
    }
    // Platform-only: super admin passed above, nobody else gets these.
    if (PLATFORM_ONLY_SECTIONS.has(section)) {
      return next(forbidden("This section belongs to the platform, not a brand."));
    }
    // Platform team: brand-less staff holding the key. Any brand account is refused — not their inbox.
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

/** Refuse STAFF and SUPER_ADMIN from customer feature APIs — a write there would mint customer state
 *  (Profile, agent) for an account that should never hold any. Must run after requireAuth. */
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
