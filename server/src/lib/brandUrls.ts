import type { Brand } from "@prisma/client";
import { appBaseUrl, canonicalApiBaseUrl, platformDomain, shareLinkBaseUrl } from "../env.js";
import { brandHostnames, brandOrigin, cachedBrand } from "../services/brands.js";
import { getEffective } from "../services/settings.js";
import { currentBrandId } from "./brandContext.js";

/* ------------------------------------------------------------------ *
 *  Where a link should point, and what name should be on it.
 *
 *  Every outbound artefact a customer sees — a login link in an email, an
 *  unsubscribe footer, the "more info" URL in a summary SMS — used to be
 *  built from ONE global base URL. On a white-label deployment that is a
 *  leak: a customer of Acme, who has only ever seen acme.com, receives a
 *  mail telling them to sign in at the platform's own domain.
 *
 *  These helpers resolve the same links against the brand instead, falling
 *  back to the platform's globals when there is no brand — which is exactly
 *  the behaviour that existed before, so platform-level sends are unchanged.
 *
 *  The brand is taken from async-local context by default (see
 *  brandContext.ts), so a sender five frames below a route gets the right
 *  answer without anyone threading an argument through. Off-request work —
 *  schedulers, webhook workers — has no ambient brand and must pass one.
 * ------------------------------------------------------------------ */

/** Resolve the brand to build links for: the one given, else the ambient one. */
function resolve(brandId?: string | null): Brand | null {
  return cachedBrand(brandId === undefined ? currentBrandId() : brandId);
}

/**
 * The origin this brand's customers reach the app at, with no trailing slash.
 *
 * Falls back to the platform's APP_URL for platform-level accounts. Note this
 * only ever returns a brand's VERIFIED vanity domain — see brandOrigin() — so a
 * half-configured domain can never end up in an email that has already been sent.
 */
export function brandAppOrigin(brandId?: string | null): string {
  return brandOrigin(resolve(brandId)) ?? appBaseUrl;
}

/** An absolute app URL for this brand, e.g. brandAppUrl("/login"). */
export function brandAppUrl(path: string, brandId?: string | null): string {
  const base = brandAppOrigin(brandId);
  return path.startsWith("/") ? `${base}${path}` : `${base}/${path}`;
}

/**
 * Base for the public conversation link in a summary SMS.
 *
 * Deliberately NOT the brand's domain. A brand's domain serves the SPA and
 * nothing else; the API — and with it the /c/* conversation page, the call
 * webhooks and the recording proxy — stays on the platform's own host for
 * every tenant. Building this link on the brand would depend on that brand's
 * edge proxying /c/* back here: one more thing per brand to configure, and one
 * more thing to break. The page itself is still branded — it paints the name
 * of the brand that owns the call (see routes/publicCall.routes.ts).
 */
export function brandShareOrigin(): string {
  return shareLinkBaseUrl;
}

/**
 * The API origin every brand's app talks to — one host for all tenants.
 *
 * The SPA on a brand's domain is built with VITE_API_URL pointing here, and
 * every provider callback (Vapi, Twilio, Stripe, WhatsApp, Google) is
 * registered against it, so creating a brand provisions nothing API-side:
 * no DNS, no certificate, no webhook re-registration.
 */
export function platformApiOrigin(): string {
  return canonicalApiBaseUrl;
}

/**
 * What to call the product in copy this brand's customers read.
 *
 * A brand's display name, else the platform's configured app name, else the
 * platform domain. Never a hardcoded literal: a subject line reading
 * "your hello22.ai digest" is the single most obvious white-label leak, and it
 * is the kind that only ever gets noticed by the client.
 */
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

/**
 * Whether an origin is one we are willing to redirect a browser back to after
 * an OAuth round-trip.
 *
 * This is an open-redirect guard, so it is an allow-list of exact origins and
 * nothing else: every host that currently routes to a live brand, plus the
 * platform's own configured origins. A `startsWith`/suffix test would accept
 * `https://hello22.ai.attacker.com`, which is precisely the shape of the bug
 * this exists to prevent.
 */
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
