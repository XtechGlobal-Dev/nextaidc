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

/**
 * Resolve the tenant for every incoming request from its Host, and make it the
 * ambient brand for everything the request goes on to do (see lib/brandContext).
 *
 * This runs BEFORE auth on purpose: a visitor on acme.example.com must get
 * Acme's logo, palette and font on the login screen, long before we know who
 * they are. Once they authenticate, `requireAuth` narrows the ambient brand to
 * the one their account actually belongs to.
 */
export function brandContext(req: Request, _res: Response, next: NextFunction) {
  // Behind a proxy the original Host lands in X-Forwarded-Host; Express only
  // honours it via `trust proxy`, which req.hostname already respects — but that
  // strips nothing else we need, so prefer it and fall back to the raw header.
  const host = req.hostname || req.headers.host;
  let brand = resolveBrandForHost(host);

  // The API usually does NOT share a hostname with the app — it's api.example.com
  // while the visitor is on acme.example.com, and in dev it's a different port
  // entirely. So when the Host isn't a brand, fall back to where the browser says
  // the request came FROM. Origin is set by the browser and can't be changed by
  // page script, which makes it as good a signal here as Host; Referer covers
  // the same-origin navigations that omit Origin.
  if (!brand) brand = resolveBrandForHost(originHost(req.get("origin")));
  if (!brand) brand = resolveBrandForHost(originHost(req.get("referer")));

  // Path routing (`example.com/acme/...`). Every brand shares one host there,
  // so the host tells us nothing and the client has to name its front door.
  //
  // That makes the brand client-asserted, which is fine for what it decides.
  // It selects a PUBLIC front door — a name, a palette, and which sender an
  // anonymous message goes out through. It grants nothing: the moment a request
  // is authenticated, `requireAuth` replaces this with the tenant the account
  // actually belongs to, so no data is ever reached by claiming a brand. Only a
  // real, active slug resolves; anything else falls through to the platform.
  if (!brand) brand = brandBySlug(req.get("x-brand"));

  // Dev/test convenience: name a brand by its raw id. Unlike the slug header
  // above this bypasses the public lookup, so it stays out of production.
  if (!brand && process.env.NODE_ENV !== "production") {
    const forced = req.get("x-brand-id") ?? "";
    // Still honours status, so "suspended" behaves the same way in dev as it
    // does in production rather than only being testable against real DNS.
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
