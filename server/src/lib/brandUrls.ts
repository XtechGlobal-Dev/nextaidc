import type { Brand } from "@prisma/client";
import { appBaseUrl, canonicalApiBaseUrl, platformDomain, shareLinkBaseUrl } from "../env.js";
import { brandHostnames, brandOrigin, cachedBrand } from "../services/brands.js";
import { getEffective } from "../services/settings.js";
import { currentBrandId } from "./brandContext.js";

// Brand-aware links and names for outbound copy — a global base URL leaks the platform domain to
// white-label customers. Brand comes from async-local context; off-request work must pass one.

/** Resolve the brand to build links for: the one given, else the ambient one. */
function resolve(brandId?: string | null): Brand | null {
  return cachedBrand(brandId === undefined ? currentBrandId() : brandId);
}

/** App origin for this brand's customers (no trailing slash). Only a VERIFIED vanity domain is ever
 *  returned, so a half-configured one can't land in a sent email. */
export function brandAppOrigin(brandId?: string | null): string {
  return brandOrigin(resolve(brandId)) ?? appBaseUrl;
}

/** An absolute app URL for this brand, e.g. brandAppUrl("/login"). */
export function brandAppUrl(path: string, brandId?: string | null): string {
  const base = brandAppOrigin(brandId);
  return path.startsWith("/") ? `${base}${path}` : `${base}/${path}`;
}

/** Base for the SMS conversation link. Deliberately the platform host, not the brand's — /c/* is served
 *  by the API, and a brand domain only serves the SPA. The page itself still paints the brand. */
export function brandShareOrigin(): string {
  return shareLinkBaseUrl;
}

/** One API host for all tenants — provider callbacks are registered against it, so a new brand
 *  provisions nothing API-side. */
export function platformApiOrigin(): string {
  return canonicalApiBaseUrl;
}

/** Product name for customer-facing copy: brand name, else app name, else platform domain. Never a
 *  hardcoded literal — that's the most obvious white-label leak. */
export function brandDisplayName(brandId?: string | null): string {
  const brand = resolve(brandId);
  if (brand?.name.trim()) return brand.name.trim();
  return getEffective("branding.appName").trim() || platformDomain;
}

/** The support address to show this brand's customers, if it set one. */
export function brandSupportEmail(brandId?: string | null): string {
  const brand = resolve(brandId);
  if (brand?.supportEmail.trim()) return brand.supportEmail.trim();
  const from = getEffective("smtp.from", brand?.id ?? null);
  return from.match(/[\w.+-]+@[\w.-]+/)?.[0] ?? "";
}

/** Open-redirect guard for the OAuth return: exact-origin allow-list only. A prefix/suffix test would
 *  accept `https://hello22.ai.attacker.com`. */
export function isAllowedReturnOrigin(origin: string, allowed: Iterable<string>): boolean {
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    return false;
  }
  if (parsed.protocol !== "https:" && parsed.hostname !== "localhost") return false;
  const normalized = parsed.origin.toLowerCase();
  for (const candidate of allowed) {
    try {
      if (new URL(candidate).origin.toLowerCase() === normalized) return true;
    } catch {
      /* not a URL — skip */
    }
  }
  return false;
}

/** Every origin a brand legitimately answers on, for the guard above. */
export function brandReturnOrigins(brand: Brand | null): string[] {
  if (!brand) return [];
  return brandHostnames(brand).map((h) => `https://${h}`);
}
