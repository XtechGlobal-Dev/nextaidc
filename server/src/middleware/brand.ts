import type { NextFunction, Request, Response } from "express";
import type { Brand } from "@prisma/client";
import { resolveBrandForHost, brandBySlug, cachedBrand } from "../services/brands.js";
import { runWithBrand } from "../lib/brandContext.js";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      /** The white-label tenant this request arrived through (null = platform). */
      brand?: Brand | null;
    }
  }
}

/** Resolve the tenant from Host and make it the ambient brand. Runs BEFORE auth on purpose so the login
 *  screen is branded; requireAuth then narrows it to the account's own tenant. */
export function brandContext(req: Request, _res: Response, next: NextFunction) {
  // req.hostname honours X-Forwarded-Host via `trust proxy`; fall back to the raw header.
  const host = req.hostname || req.headers.host;
  let brand = resolveBrandForHost(host);

  // The API rarely shares the app's hostname, so fall back to Origin (browser-set, not script-writable)
  // and Referer (covers same-origin navigations that omit Origin).
  if (!brand) brand = resolveBrandForHost(originHost(req.get("origin")));
  if (!brand) brand = resolveBrandForHost(originHost(req.get("referer")));

  // Path routing: the client names its front door. Client-asserted is fine here — it picks a PUBLIC
  // look and sender and grants nothing; requireAuth replaces it with the account's real tenant.
  if (!brand) brand = brandBySlug(req.get("x-brand"));

  // Dev/test only: bypasses the public lookup by raw id.
  if (!brand && process.env.NODE_ENV !== "production") {
    const forced = req.get("x-brand-id") ?? "";
    // Still honours status so "suspended" behaves the same in dev.
    if (forced) {
      const candidate = cachedBrand(forced);
      brand = candidate?.status === "active" ? candidate : null;
    }
  }

  req.brand = brand;
  runWithBrand(brand?.id ?? null, () => next());
}

/** The hostname inside an Origin/Referer header, or undefined if unparseable. */
function originHost(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    return new URL(value).hostname;
  } catch {
    return undefined;
  }
}
