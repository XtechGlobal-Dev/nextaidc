import type { NextFunction, Request, Response } from "express";
import { HttpError } from "../lib/http.js";
import { brandModuleEnabled, brandModuleLabel, type BrandModuleId } from "../services/brandSetup.js";

/** Refuse a module's API on a brand that switched it off — hiding the nav isn't enough, the URL stays
 *  routable. Checks the REQUEST's brand; no brand (platform app, webhooks, schedulers) is never gated. */
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
