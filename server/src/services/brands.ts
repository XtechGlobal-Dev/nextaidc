import { randomBytes } from "node:crypto";
import type { Brand } from "@prisma/client";
import { prisma } from "../prisma.js";
import { brandIdForOwner } from "./customerDirectory.js";
import { badRequest, notFound } from "../lib/http.js";
import {
  allowUnverifiedBrandDomains,
  platformDomains,
  platformSubdomainHost,
  platformSubdomainUrl,
} from "../env.js";
import {
  COLOR_PRESETS,
  CUSTOM_PRESET_ID,
  DEFAULT_FONT_ID,
  DEFAULT_PRESET_ID,
  FONTS,
  findFont,
  findPreset,
  isHexColor,
  normalizeSlug,
  slugProblem,
} from "../lib/brandTheme.js";
import { loadBrandSettings } from "./settings.js";
import {
  brandModules,
  brandPlanIds,
  brandScripts,
  brandSignupMode,
  resolveSetup,
  type BrandModules,
  type BrandScripts,
  type BrandSetupInput,
  type SignupMode,
} from "./brandSetup.js";

// Brands (white-label tenants): subdomain, look, optional senders. Paint data is public; sending
// credentials live encrypted in brand_settings. Host -> brand runs on every request, so it reads an in-memory cache refreshed on each mutation.

/** Days a deactivated brand waits before the sweep deletes it for good (brandDeactivation.ts). */
export const BRAND_DEACTIVATION_DAYS = 30;

/** When the sweep will delete a deactivated brand; null unless it is deactivated. */
export function brandDeletesAt(brand: Pick<Brand, "status" | "deactivatedAt">): Date | null {
  if (brand.status !== "deactivated" || !brand.deactivatedAt) return null;
  return new Date(brand.deactivatedAt.getTime() + BRAND_DEACTIVATION_DAYS * 24 * 60 * 60 * 1000);
}

let bySlug = new Map<string, Brand>();
let byDomain = new Map<string, Brand>();
let byId = new Map<string, Brand>();

let settleFirstLoad: () => void = () => {};
const firstLoad = new Promise<void>((resolve) => {
  settleFirstLoad = resolve;
});

/** Settles once the boot load has landed (or given up). Until then every brand host is a stranger
 *  to CORS, so a brand's first request waits here rather than being refused. */
export function brandsReady(): Promise<void> {
  return firstLoad;
}

/** (Re)load the host-resolution cache. Safe to call on a cold DB — a failure
 *  leaves the previous snapshot in place rather than blanking every brand.
 *  `retries` is for boot: a flaky first connection would otherwise leave the
 *  cache empty for a whole refresh interval, with every brand door refused. */
export async function loadBrands(opts: { retries?: number } = {}): Promise<void> {
  const attempts = 1 + (opts.retries ?? 0);
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const rows = await prisma.brand.findMany();
      const slugs = new Map<string, Brand>();
      const domains = new Map<string, Brand>();
      const ids = new Map<string, Brand>();
      for (const b of rows) {
        slugs.set(b.slug, b);
        ids.set(b.id, b);
        // Only VERIFIED domains route: this map feeds CORS and the Origin fallback, so an unproven
        // hostname would admit a page on a domain the tenant merely typed in. Dev-only override via ALLOW_UNVERIFIED_BRAND_DOMAINS.
        if (b.customDomain && (b.domainStatus === "verified" || allowUnverifiedBrandDomains)) {
          domains.set(b.customDomain.toLowerCase(), b);
        }
      }
      bySlug = slugs;
      byDomain = domains;
      byId = ids;
      settleFirstLoad();
      return;
    } catch {
      // DB not reachable — keep whatever snapshot we have; at boot, wait and try again.
      if (attempt < attempts) await new Promise((r) => setTimeout(r, 2500));
    }
  }
  // Out of attempts: stop holding requests, the minute refresh keeps trying.
  settleFirstLoad();
}

export function cachedBrand(brandId: string | null | undefined): Brand | null {
  return brandId ? (byId.get(brandId) ?? null) : null;
}

/** Brands whose name contains `q`, by id — for a search box over a table that
 *  names its brand by id only (a brand's own database cannot join this one). */
export function brandIdsMatching(q: string): string[] {
  const needle = q.trim().toLowerCase();
  if (!needle) return [];
  return [...byId.values()].filter((b) => b.name.toLowerCase().includes(needle)).map((b) => b.id);
}

/** An ACTIVE brand by its slug — the path-routing lookup (`/acme/...`).
 *  A suspended brand resolves to null, exactly like its subdomain does. */
export function brandBySlug(slug: string | null | undefined): Brand | null {
  if (!slug) return null;
  const brand = bySlug.get(slug.trim().toLowerCase());
  return brand?.status === "active" ? brand : null;
}

/** Strip the port and any trailing dot from a Host header. */
function hostname(host: string): string {
  return host.trim().toLowerCase().replace(/:\d+$/, "").replace(/\.$/, "");
}

// Security boundary: anchoring to platformDomains stops acme.attacker.com resolving to Acme
// (CORS admits every host that resolves to a brand). One label deep, matching the wildcard record.
function platformSubdomainLabel(h: string): string | null {
  for (const apex of platformDomains) {
    if (!h.endsWith(`.${apex}`)) continue;
    const label = h.slice(0, -(apex.length + 1));
    // One label only: reject "a.b" under the apex, and the bare apex itself.
    if (!label || label.includes(".")) continue;
    return label;
  }
  return null;
}

/** Brand for a Host header: exact VERIFIED custom domain or a platform subdomain label; anything else (and any suspended brand) is null. */
export function resolveBrandForHost(host: string | undefined): Brand | null {
  if (!host) return null;
  const h = hostname(host);
  if (!h) return null;

  const exact = byDomain.get(h);
  if (exact) return exact.status === "active" ? exact : null;

  const label = platformSubdomainLabel(h);
  if (!label) return null;
  const brand = bySlug.get(label);
  if (!brand) return null;
  return brand.status === "active" ? brand : null;
}

/** Every hostname that routes to this brand: platform subdomain always, vanity domain once verified. */
export function brandHostnames(brand: Brand): string[] {
  const hosts = platformDomains.map((apex) => `${brand.slug}.${apex}`);
  if (brand.customDomain && brand.domainStatus === "verified") {
    hosts.unshift(brand.customDomain.toLowerCase());
  }
  return hosts;
}

/** Where the brand's users sign in. Gated on "verified" — a claimed-but-unpointed domain would send email login links to a dead host. */
export function brandOrigin(brand: Brand | null | undefined): string | null {
  if (!brand) return null;
  if (brand.customDomain && brand.domainStatus === "verified") {
    return `https://${brand.customDomain.toLowerCase()}`;
  }
  return platformSubdomainUrl(brand.slug);
}

/** The brand id a user belongs to (null = platform-level). For off-request work
 *  — schedulers, webhooks — where there is no ambient host to resolve. */
export async function brandIdForUser(userId: string | null | undefined): Promise<string | null> {
  if (!userId) return null;
  try {
    return await brandIdForOwner(userId);
  } catch {
    return null;
  }
}

/* ------------------------------ Serialisation ----------------------------- */

/** What the admin UI receives for a brand. No secrets — those never leave the
 *  server, and the messaging overrides have their own masked endpoint. */
export interface BrandView {
  id: string;
  name: string;
  slug: string;
  customDomain: string | null;
  /** none | pending | verified | error — see the Brand model. */
  domainStatus: string;
  domainVerifiedAt: string | null;
  domainCheckedAt: string | null;
  domainError: string;
  /** Where this brand answers today (vanity domain once verified, else subdomain). */
  origin: string;
  /** The subdomain the wildcard record already covers — always live. */
  platformHost: string;
  /** See BrandStatus in the schema: provisioning → active | failed; suspended; deactivated (deleted 30 days on). */
  status: "active" | "suspended" | "provisioning" | "failed" | "deactivated";
  /** ISO, set while deactivated. */
  deactivatedAt: string | null;
  /** ISO, when the sweep will delete a deactivated brand; null otherwise. */
  deletesAt: string | null;
  logoLightUrl: string;
  logoDarkUrl: string;
  faviconUrl: string;
  themePreset: string;
  primaryColor: string;
  accentColor: string;
  fontFamily: string;
  fontStyle: string;
  darkModeDefault: boolean;
  tagline: string;
  supportEmail: string;
  supportPhone: string;
  /* ---- setup: see services/brandSetup.ts ---- */
  legalName: string;
  legalAddress: string;
  termsUrl: string;
  privacyUrl: string;
  websiteUrl: string;
  helpUrl: string;
  defaultCountry: string;
  defaultTimezone: string;
  signupMode: SignupMode;
  loginHeadline: string;
  loginBlurb: string;
  modules: BrandModules;
  planIds: string[];
  trialDays: number | null;
  trialMinutes: number | null;
  cardRequired: boolean | null;
  defaultVoiceId: string;
  scripts: BrandScripts;
  addonEditable: boolean;
  maxAddonCents: number | null;
  createdAt: string;
  updatedAt: string;
  /** How many accounts sit inside this tenant, split by kind. */
  counts?: { admins: number; customers: number; total: number };
}

export function serializeBrand(b: Brand, counts?: BrandView["counts"]): BrandView {
  return {
    id: b.id,
    name: b.name,
    slug: b.slug,
    customDomain: b.customDomain,
    domainStatus: b.domainStatus,
    domainVerifiedAt: b.domainVerifiedAt?.toISOString() ?? null,
    domainCheckedAt: b.domainCheckedAt?.toISOString() ?? null,
    domainError: b.domainError,
    origin: brandOrigin(b) ?? "",
    platformHost: platformSubdomainHost(b.slug),
    status: b.status,
    deactivatedAt: b.deactivatedAt?.toISOString() ?? null,
    deletesAt: brandDeletesAt(b)?.toISOString() ?? null,
    logoLightUrl: b.logoLightUrl,
    logoDarkUrl: b.logoDarkUrl,
    faviconUrl: b.faviconUrl,
    themePreset: b.themePreset,
    primaryColor: b.primaryColor,
    accentColor: b.accentColor,
    fontFamily: b.fontFamily,
    fontStyle: b.fontStyle,
    darkModeDefault: b.darkModeDefault,
    tagline: b.tagline,
    supportEmail: b.supportEmail,
    supportPhone: b.supportPhone,
    legalName: b.legalName,
    legalAddress: b.legalAddress,
    termsUrl: b.termsUrl,
    privacyUrl: b.privacyUrl,
    websiteUrl: b.websiteUrl,
    helpUrl: b.helpUrl,
    defaultCountry: b.defaultCountry,
    defaultTimezone: b.defaultTimezone,
    signupMode: brandSignupMode(b),
    loginHeadline: b.loginHeadline,
    loginBlurb: b.loginBlurb,
    modules: brandModules(b),
    planIds: brandPlanIds(b),
    trialDays: b.trialDays,
    trialMinutes: b.trialMinutes,
    cardRequired: b.cardRequired,
    defaultVoiceId: b.defaultVoiceId,
    scripts: brandScripts(b),
    addonEditable: b.addonEditable,
    maxAddonCents: b.maxAddonCents,
    createdAt: b.createdAt.toISOString(),
    updatedAt: b.updatedAt.toISOString(),
    ...(counts ? { counts } : {}),
  };
}

/** What /api/config hands every visitor to paint the brand before sign-in. Small and non-secret on purpose. */
export interface PublicBrand {
  id: string;
  name: string;
  slug: string;
  tagline: string;
  supportEmail: string;
  supportPhone: string;
  logoLightUrl: string;
  logoDarkUrl: string;
  faviconUrl: string;
  theme: {
    preset: string;
    primaryColor: string;
    accentColor: string;
    /** Catalog id — the client maps it to a CSS stack + Google Fonts family. */
    fontFamily: string;
    fontStyle: string;
    /** Full CSS font stack, resolved here so the client never guesses. */
    fontStack: string;
    /** Google Fonts family to load, or "" for a system face. */
    googleFamily: string;
    darkModeDefault: boolean;
  };
  /** The brand's own sites, for Help links and footers ("" when unset). */
  websiteUrl: string;
  helpUrl: string;
  termsUrl: string;
  privacyUrl: string;
  /** Legal entity shown in footers; "" falls back to the brand name. */
  legalName: string;
  /** "invite" → the sign-up screen is closed; accounts come from the brand. */
  signupMode: SignupMode;
  /** Sign-in screen copy; "" → the platform's default lines. */
  loginHeadline: string;
  loginBlurb: string;
  /** Which optional modules this brand's customers get. */
  modules: BrandModules;
}

export function publicBrand(b: Brand): PublicBrand {
  const font = findFont(b.fontFamily) ?? findFont(DEFAULT_FONT_ID)!;
  return {
    id: b.id,
    name: b.name,
    slug: b.slug,
    tagline: b.tagline,
    supportEmail: b.supportEmail,
    supportPhone: b.supportPhone,
    logoLightUrl: b.logoLightUrl,
    logoDarkUrl: b.logoDarkUrl,
    faviconUrl: b.faviconUrl,
    theme: {
      preset: b.themePreset,
      primaryColor: b.primaryColor,
      accentColor: b.accentColor,
      fontFamily: font.id,
      fontStyle: font.group,
      fontStack: font.stack,
      googleFamily: font.googleFamily,
      darkModeDefault: b.darkModeDefault,
    },
    websiteUrl: b.websiteUrl,
    helpUrl: b.helpUrl,
    termsUrl: b.termsUrl,
    privacyUrl: b.privacyUrl,
    legalName: b.legalName,
    signupMode: brandSignupMode(b),
    loginHeadline: b.loginHeadline,
    loginBlurb: b.loginBlurb,
    modules: brandModules(b),
  };
}

/* -------------------------------- Mutations ------------------------------- */

const DEFAULT_BRAND_PRIMARY = "#2c76ed";
const DEFAULT_BRAND_ACCENT = "#7c5cfc";

export interface BrandIdentityInput {
  name: string;
  slug: string;
  customDomain?: string | null;
  status?: "active" | "suspended";
  logoLightUrl?: string;
  logoDarkUrl?: string;
  faviconUrl?: string;
  themePreset?: string;
  primaryColor?: string;
  accentColor?: string;
  fontFamily?: string;
  darkModeDefault?: boolean;
  tagline?: string;
  supportEmail?: string;
  supportPhone?: string;
}

/** Identity + look, plus the policy half that brandSetup.ts validates. */
export type BrandInput = BrandIdentityInput & BrandSetupInput;

// Colours matching a preset keep its id; hand-picked ones flip to "custom" so the UI's selected swatch is never a lie.
function resolveTheme(input: Partial<BrandInput>) {
  const fontId = (input.fontFamily ?? DEFAULT_FONT_ID).trim();
  const font = findFont(fontId);
  if (!font) {
    throw badRequest(`Unknown font "${fontId}". Pick one from the theme catalog.`);
  }

  const presetId = (input.themePreset ?? DEFAULT_PRESET_ID).trim();
  const preset = findPreset(presetId);
  if (presetId !== CUSTOM_PRESET_ID && !preset) {
    throw badRequest(`Unknown colour preset "${presetId}".`);
  }

  const primary = (input.primaryColor ?? preset?.primary ?? "").trim() || DEFAULT_BRAND_PRIMARY;
  const accent = (input.accentColor ?? preset?.accent ?? "").trim() || DEFAULT_BRAND_ACCENT;
  if (!isHexColor(primary)) throw badRequest("Primary colour must be a hex value like #2C76ED.");
  if (!isHexColor(accent)) throw badRequest("Accent colour must be a hex value like #7C5CFC.");

  const matches =
    preset &&
    preset.primary.toLowerCase() === primary.toLowerCase() &&
    preset.accent.toLowerCase() === accent.toLowerCase();

  return {
    themePreset: matches ? preset.id : CUSTOM_PRESET_ID,
    primaryColor: primary.toLowerCase(),
    accentColor: accent.toLowerCase(),
    fontFamily: font.id,
    fontStyle: font.group,
    darkModeDefault: input.darkModeDefault ?? false,
  };
}

/** Normalise + validate a subdomain, refusing reserved labels and duplicates. */
export async function assertSlugAvailable(rawSlug: string, exceptBrandId?: string): Promise<string> {
  const slug = normalizeSlug(rawSlug);
  const problem = slugProblem(slug);
  if (problem) throw badRequest(problem);
  const existing = await prisma.brand.findUnique({ where: { slug } });
  if (existing && existing.id !== exceptBrandId) {
    throw badRequest(`The subdomain "${slug}" is already taken by another brand.`);
  }
  return slug;
}

/** Normalise a pasted vanity domain to a bare hostname, tolerating the scheme,
 *  path, port, trailing dot and stray whitespace an operator copies in. */
export function normalizeDomain(raw: string | null | undefined): string {
  return (raw ?? "")
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/[/?#].*$/, "")
    .replace(/:\d+$/, "")
    .replace(/\.$/, "");
}

async function assertDomainAvailable(
  raw: string | null | undefined,
  exceptBrandId?: string,
): Promise<string | null> {
  const domain = normalizeDomain(raw);
  if (!domain) return null;
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(domain)) {
    throw badRequest("Custom domain must be a bare hostname like app.brand.com.");
  }
  if (domain.length > 253 || domain.split(".").some((l) => !l || l.length > 63)) {
    throw badRequest("That hostname isn't valid — each label must be 1–63 characters.");
  }
  // A vanity entry on our own apex would shadow another brand's subdomain — the exact-match lookup runs BEFORE the slug lookup.
  for (const apex of platformDomains) {
    if (domain === apex || domain.endsWith(`.${apex}`)) {
      throw badRequest(
        `"${domain}" is on the platform domain — brands get that automatically from their subdomain. Use a domain the brand owns.`,
      );
    }
  }
  const existing = await prisma.brand.findUnique({ where: { customDomain: domain } });
  if (existing && existing.id !== exceptBrandId) {
    throw badRequest(`The domain "${domain}" is already pointed at another brand.`);
  }
  return domain;
}

/** A fresh ownership-proof nonce for a domain claim. URL-safe hex so it survives
 *  being copied out of the admin UI and into any registrar's TXT field. */
export function newDomainToken(): string {
  return randomBytes(16).toString("hex");
}

export async function createBrand(input: BrandInput, createdById: string): Promise<Brand> {
  const name = input.name.trim();
  if (name.length < 2) throw badRequest("Brand name must be at least 2 characters.");
  const slug = await assertSlugAvailable(input.slug || name);
  const customDomain = await assertDomainAvailable(input.customDomain);

  const brand = await prisma.brand.create({
    data: {
      name,
      slug,
      customDomain,
      // A domain named at creation starts unproven — the client still has to
      // publish the records.
      domainStatus: customDomain ? "pending" : "none",
      domainToken: customDomain ? newDomainToken() : "",
      // Not live yet: the brand's own database is set up right after this row
      // exists (provisionBrand below), and only then does the door open.
      status: "provisioning",
      logoLightUrl: (input.logoLightUrl ?? "").trim(),
      logoDarkUrl: (input.logoDarkUrl ?? "").trim(),
      faviconUrl: (input.faviconUrl ?? "").trim(),
      tagline: (input.tagline ?? "").trim(),
      supportEmail: (input.supportEmail ?? "").trim(),
      supportPhone: (input.supportPhone ?? "").trim(),
      createdById,
      ...resolveTheme(input),
      ...resolveSetup(input),
    },
  });
  await loadBrands();
  // Row exists first so a provisioning failure shows as "failed" and is retryable instead of a
  // vanished create. Provisioning also seeds the tenant's starter support queues.
  return provisionBrand(brand.id, input.status ?? "active");
}

/** Sets up (or retries) the brand's database, then sets `thenStatus`; failure marks it "failed" for a retry. Lazy import keeps the Neon/migration code out of the per-request import graph. */
export async function provisionBrand(
  brandId: string,
  thenStatus: "active" | "suspended" = "active",
): Promise<Brand> {
  const { provisionBrandDatabase } = await import("./tenantProvisioning.js");
  let status: "active" | "suspended" | "failed" = thenStatus;
  try {
    await provisionBrandDatabase({ brandId });
  } catch (err) {
    status = "failed";
    console.error(`[brands] database provisioning failed for brand ${brandId}:`, err);
  }
  const brand = await prisma.brand.update({ where: { id: brandId }, data: { status } });
  await loadBrands();
  return brand;
}

export async function updateBrand(id: string, input: Partial<BrandInput>): Promise<Brand> {
  const existing = await prisma.brand.findUnique({ where: { id } });
  if (!existing) throw notFound("Brand not found");

  const data: Record<string, unknown> = {};
  if (input.name !== undefined) {
    const name = input.name.trim();
    if (name.length < 2) throw badRequest("Brand name must be at least 2 characters.");
    data.name = name;
  }
  if (input.slug !== undefined) data.slug = await assertSlugAvailable(input.slug, id);
  if (input.customDomain !== undefined) {
    const next = await assertDomainAvailable(input.customDomain, id);
    data.customDomain = next;
    // A changed domain has proven nothing yet — never carry "verified" across, or links point at a host that may not resolve.
    if (next !== existing.customDomain) {
      data.domainStatus = next ? "pending" : "none";
      data.domainToken = next ? newDomainToken() : "";
      data.domainVerifiedAt = null;
      data.domainCheckedAt = null;
      data.domainError = "";
    }
  }
  if (input.status !== undefined) {
    // A brand whose database isn't ready can be neither switched on nor "off":
    // it is in setup, and the only way out is Retry on its page.
    if (existing.status === "provisioning" || existing.status === "failed") {
      throw badRequest("This brand's database isn't ready yet — finish setup (Retry) first.");
    }
    // Deactivation has its own door (brandDeactivation.ts): the countdown must be cleared, not just the status.
    if (existing.status === "deactivated") {
      throw badRequest("This brand is deactivated — reactivate it first.");
    }
    data.status = input.status;
  }
  for (const key of [
    "logoLightUrl",
    "logoDarkUrl",
    "faviconUrl",
    "tagline",
    "supportEmail",
    "supportPhone",
  ] as const) {
    if (input[key] !== undefined) data[key] = (input[key] ?? "").trim();
  }
  Object.assign(data, resolveSetup(input));

  // Theme fields move together — a preset sets both colours, so resolving one
  // in isolation would leave the pair inconsistent. Merge onto what's stored.
  const touchesTheme =
    input.themePreset !== undefined ||
    input.primaryColor !== undefined ||
    input.accentColor !== undefined ||
    input.fontFamily !== undefined ||
    input.darkModeDefault !== undefined;
  if (touchesTheme) {
    // Switching preset re-derives BOTH colours from it; an explicitly sent
    // colour still wins, which is what makes hand-picking flip it to "custom".
    const switchingPreset =
      input.themePreset !== undefined && input.themePreset !== existing.themePreset;
    const fromPreset = switchingPreset ? findPreset(input.themePreset!) : undefined;
    Object.assign(
      data,
      resolveTheme({
        themePreset: input.themePreset ?? existing.themePreset,
        primaryColor: input.primaryColor ?? fromPreset?.primary ?? existing.primaryColor,
        accentColor: input.accentColor ?? fromPreset?.accent ?? existing.accentColor,
        fontFamily: input.fontFamily ?? existing.fontFamily,
        darkModeDefault: input.darkModeDefault ?? existing.darkModeDefault,
      }),
    );
  }

  const brand = await prisma.brand.update({ where: { id }, data });
  await loadBrands();
  return brand;
}

/** Deletes a brand for good: its database (and every account in it) goes first, then the row.
 *  If the database can't be dropped the brand stays, so the operator can retry. For a grace period use deactivation instead (brandDeactivation.ts). */
export async function deleteBrand(id: string): Promise<void> {
  const { destroyBrandDatabase } = await import("./tenantProvisioning.js");
  await destroyBrandDatabase(id);
  await prisma.brand.delete({ where: { id } });
  await Promise.all([loadBrands(), loadBrandSettings()]);
}

/** The catalog the brand editor's pickers are built from. */
export function themeCatalog() {
  return {
    presets: COLOR_PRESETS,
    fonts: FONTS,
    defaults: { preset: DEFAULT_PRESET_ID, font: DEFAULT_FONT_ID },
  };
}
