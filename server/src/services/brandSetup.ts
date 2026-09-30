import type { Brand, Prisma } from "@prisma/client";
import { badRequest } from "../lib/http.js";
import { isValidTimeZone } from "../lib/phoneTimeZone.js";

// Brand policy (how a brand behaves; look/name live in brands.ts). Readers accept null = platform
// so callers never branch on "is there a brand?". Must not import brands.ts — it imports this.

/* -------------------------------- Modules -------------------------------- */

/** Modules a brand can switch off. Only optional products — dashboard, inbox and AI Brain are the receptionist itself. */
export const BRAND_MODULES = [
  {
    id: "booking",
    label: "Booking",
    description: "Website booking module and calendar appointments.",
  },
  {
    id: "transfer",
    label: "Call Transfer",
    description: "Hand a live call over to a human.",
  },
  {
    id: "crm",
    label: "Connect CRM",
    description: "Lead delivery into the customer's own CRM.",
  },
  {
    id: "smsToCaller",
    label: "SMS to Caller",
    description: "The AI texts callers the details they ask for mid-call.",
  },
  {
    id: "whatsapp",
    label: "WhatsApp",
    description: "WhatsApp call summaries and inbound auto-replies.",
  },
] as const;

export type BrandModuleId = (typeof BRAND_MODULES)[number]["id"];
export type BrandModules = Record<BrandModuleId, boolean>;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** The super admin's on/off switches, as configured. No brand = all on; an unwritten key is on, so a brand
 *  created before a module existed keeps getting it. This is what the brand editor shows and saves back —
 *  never the effective set, or saving would switch every unbought add-on off for good. */
export function brandModuleSwitches(brand: Brand | null | undefined): BrandModules {
  const raw = isPlainObject(brand?.modules) ? brand!.modules : {};
  const out = {} as BrandModules;
  for (const m of BRAND_MODULES) out[m.id] = (raw as Record<string, unknown>)[m.id] !== false;
  return out;
}

/** What the brand's people actually get: switched on AND, when it's sold as an add-on, bought. Every gate
 *  (nav, API middleware, public config) reads this one. */
export function brandModules(brand: Brand | null | undefined): BrandModules {
  const out = brandModuleSwitches(brand);
  const prices = brandFeaturePrices(brand);
  const bought = new Set(brandPurchasedFeatures(brand));
  for (const m of BRAND_MODULES) {
    if (prices[m.id] !== undefined && !bought.has(m.id)) out[m.id] = false;
  }
  return out;
}

export function brandModuleEnabled(
  brand: Brand | null | undefined,
  id: BrandModuleId,
): boolean {
  return brandModules(brand)[id];
}

export function brandModuleLabel(id: BrandModuleId): string {
  return BRAND_MODULES.find((m) => m.id === id)?.label ?? id;
}

export function isBrandModuleId(v: unknown): v is BrandModuleId {
  return typeof v === "string" && BRAND_MODULES.some((m) => m.id === v);
}

/* ---------------------------- Feature add-ons ---------------------------- */
// "Feature add-ons" — modules the brand must BUY from the platform. Not to be confused with the plan
// "addon" (addonEditable / maxAddonCents), which is the brand's own markup on a plan's price.

/** Largest monthly add-on price, in cents. */
export const MAX_FEATURE_PRICE_CENTS = 10_000_000;

/** Monthly price in cents of each module sold as an add-on. A listed module is locked until bought. */
export function brandFeaturePrices(brand: Brand | null | undefined): Partial<Record<BrandModuleId, number>> {
  const raw = isPlainObject(brand?.featurePrices) ? (brand!.featurePrices as Record<string, unknown>) : {};
  const out: Partial<Record<BrandModuleId, number>> = {};
  for (const m of BRAND_MODULES) {
    const v = raw[m.id];
    if (typeof v === "number" && Number.isInteger(v) && v > 0) out[m.id] = v;
  }
  return out;
}

/** Add-on modules the brand is paying for. */
export function brandPurchasedFeatures(brand: Brand | null | undefined): BrandModuleId[] {
  const raw = brand?.purchasedFeatures;
  return Array.isArray(raw) ? raw.filter(isBrandModuleId) : [];
}

/** The platform's cut: is this brand billed at all? A fee, or any add-on it has bought. */
export function brandOwesPlatform(brand: Brand | null | undefined): boolean {
  return (brand?.platformFeeCents ?? 0) > 0 || brandPurchasedFeatures(brand).length > 0;
}

/* --------------------------------- Holds --------------------------------- */

/** Why a brand's AI is paused. "minutes" stops calls; "ai" and "billing" stop every AI channel. */
export type ServiceHold = "" | "minutes" | "ai" | "billing";

export function brandServiceHold(brand: Brand | null | undefined): ServiceHold {
  const v = brand?.serviceHold;
  return v === "minutes" || v === "ai" || v === "billing" ? v : "";
}

/** May the brand's AI answer calls right now? */
export function brandCallsAllowed(brand: Brand | null | undefined): boolean {
  return brandServiceHold(brand) === "";
}

/** May the brand's AI send texts / replies / take actions right now? A minutes cap only stops calls. */
export function brandAiAllowed(brand: Brand | null | undefined): boolean {
  const hold = brandServiceHold(brand);
  return hold === "" || hold === "minutes";
}

/* --------------------------------- Plans --------------------------------- */

/** Plan ids this brand sells; empty means "every active platform plan". */
export function brandPlanIds(brand: Brand | null | undefined): string[] {
  const raw = brand?.planIds;
  if (!Array.isArray(raw)) return [];
  return raw.filter((v): v is string => typeof v === "string" && v.trim().length > 0);
}

/* -------------------------------- Scripts -------------------------------- */

export interface BrandScripts {
  head: string;
  body: string;
  footer: string;
}

/** Generous per-slot cap — GTM plus a couple of pixels fit well within this.
 *  Mirrors services/seo.ts, which owns the platform's own snippets. */
const MAX_SCRIPT = 20_000;

const cleanScript = (v: unknown) => (typeof v === "string" ? v.trim().slice(0, MAX_SCRIPT) : "");

export function brandScripts(brand: Brand | null | undefined): BrandScripts {
  const raw = isPlainObject(brand?.scripts) ? (brand!.scripts as Record<string, unknown>) : {};
  return { head: cleanScript(raw.head), body: cleanScript(raw.body), footer: cleanScript(raw.footer) };
}

/* -------------------------------- Policies ------------------------------- */

export const SIGNUP_MODES = ["public", "invite"] as const;
export type SignupMode = (typeof SIGNUP_MODES)[number];

export function brandSignupMode(brand: Brand | null | undefined): SignupMode {
  return brand?.signupMode === "invite" ? "invite" : "public";
}

/** Public sign-up on this brand's door. The platform's own door (no brand) is never open — every customer belongs to a brand. */
export function brandAllowsSignup(brand: Brand | null | undefined): boolean {
  return !!brand && brandSignupMode(brand) === "public";
}

/** The brand's card-on-file policy for new sign-ups, or null to defer to the
 *  platform setting. */
export function brandCardRequired(brand: Brand | null | undefined): boolean | null {
  return typeof brand?.cardRequired === "boolean" ? brand.cardRequired : null;
}

/* ------------------------------- Normalising ------------------------------ */

export interface BrandSetupInput {
  legalName?: string;
  legalAddress?: string;
  termsUrl?: string;
  privacyUrl?: string;
  websiteUrl?: string;
  helpUrl?: string;
  defaultCountry?: string;
  defaultTimezone?: string;
  signupMode?: string;
  loginHeadline?: string;
  loginBlurb?: string;
  modules?: Partial<Record<string, boolean>> | null;
  planIds?: string[] | null;
  trialDays?: number | null;
  trialMinutes?: number | null;
  cardRequired?: boolean | null;
  defaultVoiceId?: string;
  scripts?: Partial<BrandScripts> | null;
  /** May the brand's own admin set its plan addons? */
  addonEditable?: boolean;
  /** Most a brand may add per cycle, in cents; null = no cap. */
  maxAddonCents?: number | null;
  /** What the brand pays the platform each month, in minor units; 0 = nothing. */
  platformFeeCents?: number;
  platformFeeCurrency?: string;
  /** { moduleId: monthly cents } — modules sold as feature add-ons. */
  featurePrices?: Partial<Record<string, number>> | null;
  monthlyMinuteLimit?: number | null;
  monthlyAiLimit?: number | null;
}

/** The columns resolveSetup() may write — typed so the result spreads straight
 *  into either a Prisma create or update without a cast. */
export type BrandSetupData = Partial<{
  legalName: string;
  legalAddress: string;
  termsUrl: string;
  privacyUrl: string;
  websiteUrl: string;
  helpUrl: string;
  defaultCountry: string;
  defaultTimezone: string;
  signupMode: string;
  loginHeadline: string;
  loginBlurb: string;
  modules: Prisma.InputJsonValue;
  planIds: Prisma.InputJsonValue;
  trialDays: number | null;
  trialMinutes: number | null;
  cardRequired: boolean | null;
  defaultVoiceId: string;
  scripts: Prisma.InputJsonValue;
  addonEditable: boolean;
  maxAddonCents: number | null;
  platformFeeCents: number;
  platformFeeCurrency: string;
  featurePrices: Prisma.InputJsonValue;
  monthlyMinuteLimit: number | null;
  monthlyAiLimit: number | null;
}>;

const TEXT_FIELDS = [
  "legalName",
  "legalAddress",
  "loginHeadline",
  "loginBlurb",
  "defaultVoiceId",
] as const;
const URL_FIELDS = ["termsUrl", "privacyUrl", "websiteUrl", "helpUrl"] as const;

const URL_LABELS: Record<(typeof URL_FIELDS)[number], string> = {
  termsUrl: "Terms URL",
  privacyUrl: "Privacy URL",
  websiteUrl: "Website URL",
  helpUrl: "Help URL",
};

/** Turns a pasted bare host into a URL and insists on http(s) — a "javascript:" link in an email footer must be impossible. */
export function normalizeHttpUrl(raw: string | undefined, label: string): string {
  const s = (raw ?? "").trim();
  if (!s) return "";
  const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(s) ? s : `https://${s}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    throw badRequest(`${label} must be a valid web address.`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw badRequest(`${label} must start with http:// or https://.`);
  }
  return url.href.replace(/\/$/, "");
}

function normalizeCountry(raw: string | undefined): string {
  const s = (raw ?? "").trim().toUpperCase();
  if (!s) return "";
  if (!/^[A-Z]{2}$/.test(s)) throw badRequest("Default country must be a two-letter ISO code like AU.");
  return s;
}

function normalizeTimeZone(raw: string | undefined): string {
  const s = (raw ?? "").trim();
  if (!s) return "";
  if (!isValidTimeZone(s)) throw badRequest(`"${s}" isn't a valid IANA timezone.`);
  return s;
}

function normalizeNullableInt(
  v: number | null | undefined,
  label: string,
  max: number,
): number | null {
  if (v === null || v === undefined || (v as unknown) === "") return null;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0 || n > max) {
    throw badRequest(`${label} must be a whole number between 0 and ${max}, or blank to use the platform's.`);
  }
  return n;
}

/** A monthly cap: a whole number, or blank for "no cap". */
function normalizeLimit(v: number | null | undefined, label: string): number | null {
  if (v === null || v === undefined || (v as unknown) === "") return null;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0 || n > 10_000_000) {
    throw badRequest(`${label} must be a whole number, or blank for no limit.`);
  }
  return n;
}

function normalizeFeaturePrices(raw: BrandSetupInput["featurePrices"]): Prisma.InputJsonValue {
  const src = isPlainObject(raw) ? raw : {};
  const out: Record<string, number> = {};
  for (const m of BRAND_MODULES) {
    const v = src[m.id];
    if (v === undefined || v === null) continue;
    const n = Number(v);
    if (!Number.isInteger(n) || n <= 0 || n > MAX_FEATURE_PRICE_CENTS) {
      throw badRequest(`${m.label} add-on needs a monthly price above zero.`);
    }
    out[m.id] = n;
  }
  return out;
}

function normalizeModules(raw: BrandSetupInput["modules"]): Prisma.InputJsonValue {
  const out: Record<string, boolean> = {};
  const src = isPlainObject(raw) ? raw : {};
  for (const m of BRAND_MODULES) out[m.id] = src[m.id] !== false;
  return out;
}

function normalizePlanIds(raw: BrandSetupInput["planIds"]): Prisma.InputJsonValue {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  for (const v of raw) {
    if (typeof v !== "string") continue;
    const id = v.trim();
    if (!id || id.length > 64) continue;
    seen.add(id);
  }
  if (seen.size > 100) throw badRequest("Too many plans selected.");
  return [...seen];
}

function normalizeScripts(raw: BrandSetupInput["scripts"]): Prisma.InputJsonValue {
  const src = isPlainObject(raw) ? raw : {};
  return { head: cleanScript(src.head), body: cleanScript(src.body), footer: cleanScript(src.footer) };
}

/** Validates the setup half of a brand payload. Only keys actually sent come back, so it serves both create and update. */
export function resolveSetup(input: BrandSetupInput): BrandSetupData {
  const data: BrandSetupData = {};
  for (const key of TEXT_FIELDS) {
    if (input[key] !== undefined) data[key] = (input[key] ?? "").trim().slice(0, 500);
  }
  for (const key of URL_FIELDS) {
    if (input[key] !== undefined) data[key] = normalizeHttpUrl(input[key], URL_LABELS[key]);
  }
  if (input.defaultCountry !== undefined) data.defaultCountry = normalizeCountry(input.defaultCountry);
  if (input.defaultTimezone !== undefined) data.defaultTimezone = normalizeTimeZone(input.defaultTimezone);
  if (input.signupMode !== undefined) {
    const mode = (input.signupMode ?? "").trim();
    if (!(SIGNUP_MODES as readonly string[]).includes(mode)) {
      throw badRequest(`Sign-up mode must be one of: ${SIGNUP_MODES.join(", ")}.`);
    }
    data.signupMode = mode;
  }
  if (input.modules !== undefined) data.modules = normalizeModules(input.modules);
  if (input.planIds !== undefined) data.planIds = normalizePlanIds(input.planIds);
  if (input.trialDays !== undefined) data.trialDays = normalizeNullableInt(input.trialDays, "Trial days", 365);
  if (input.trialMinutes !== undefined) {
    data.trialMinutes = normalizeNullableInt(input.trialMinutes, "Trial minutes", 100_000);
  }
  if (input.cardRequired !== undefined) {
    data.cardRequired = input.cardRequired === null ? null : Boolean(input.cardRequired);
  }
  if (input.scripts !== undefined) data.scripts = normalizeScripts(input.scripts);
  if (input.addonEditable !== undefined) data.addonEditable = Boolean(input.addonEditable);
  if (input.maxAddonCents !== undefined) {
    data.maxAddonCents = normalizeNullableInt(input.maxAddonCents, "Addon cap", 10_000_000);
  }
  if (input.platformFeeCents !== undefined) {
    const n = Number(input.platformFeeCents);
    if (!Number.isInteger(n) || n < 0 || n > 10_000_000) {
      throw badRequest("The monthly fee must be a whole amount in minor units (0 for none).");
    }
    data.platformFeeCents = n;
  }
  if (input.platformFeeCurrency !== undefined) {
    const c = (input.platformFeeCurrency ?? "").trim().toLowerCase();
    if (!/^[a-z]{3}$/.test(c)) throw badRequest("Currency must be a three-letter code like usd.");
    data.platformFeeCurrency = c;
  }
  if (input.featurePrices !== undefined) data.featurePrices = normalizeFeaturePrices(input.featurePrices);
  if (input.monthlyMinuteLimit !== undefined) {
    data.monthlyMinuteLimit = normalizeLimit(input.monthlyMinuteLimit, "Monthly minutes");
  }
  if (input.monthlyAiLimit !== undefined) {
    data.monthlyAiLimit = normalizeLimit(input.monthlyAiLimit, "Monthly AI interactions");
  }
  return data;
}
