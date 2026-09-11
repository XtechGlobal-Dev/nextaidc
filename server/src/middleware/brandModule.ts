import type { NextFunction, Request, Response } from "express";
import { HttpError } from "../lib/http.js";
import { brandModuleEnabled, brandModuleLabel, type BrandModuleId } from "../services/brandSetup.js";

/**
 * Refuse a module's owner API on a brand that has switched that module off.
 *
 * Mounted in front of a whole router (see routes/index.ts), so it runs before
 * that router's own auth. The brand it checks is the one the REQUEST arrived
 * through — resolved by brandContext from the host, the Origin, or the X-Brand
 * header — which is the brand whose front door the SPA is showing. A request
 * with no brand (the platform's own app, a provider webhook, a scheduler) is
 * never gated: the platform runs every module, and a webhook's brand is the
 * call's, not the request's.
 *
 * Hiding the nav item is not enough on its own: the page stays routable by
 * URL, and a brand that sold its customers "no booking" should not have the
 * booking API quietly answering anyway.
 */
export function requireBrandModule(id: BrandModuleId) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    const brand = req.brand ?? null;
    if (brand && !brandModuleEnabled(brand, id)) {
      next(
        new HttpError(403, `${brandModuleLabel(id)} isn't available on ${brand.name}.`, {
          code: "module_disabled",
          module: id,
        }),
      );
      return;
    }
    next();
  };
}
