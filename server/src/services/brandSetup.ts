import type { Brand, Prisma } from "@prisma/client";
import { badRequest } from "../lib/http.js";
import { isValidTimeZone } from "../lib/phoneTimeZone.js";

/* ------------------------------------------------------------------ *
 *  Brand setup — the policy half of a tenant.
 *
 *  Name, address and look are in services/brands.ts. This file owns
 *  the fields that decide how the brand BEHAVES: who may sign up,
 *  which modules its customers see, which plans it sells, what its
 *  trial looks like, what its emails are signed as. Two halves:
 *
 *    readers     — brandModules(), brandPlanIds(), … Every one accepts
 *                  null (no brand = the platform) and answers with the
 *                  platform's behaviour, so callers never branch on
 *                  "is there a brand?".
 *    normalisers — resolveSetup() turns an admin payload into columns,
 *                  validating as it goes. Keeps brands.ts's create /
 *                  update paths to a one-line spread.
 *
 *  No import of brands.ts here, on purpose — brands.ts imports this.
 * ------------------------------------------------------------------ */

/* -------------------------------- Modules -------------------------------- */

/**
 * The customer-facing modules a brand can switch off. Deliberately the ones
 * that are optional products in their own right — the dashboard, inbox and
 * AI Brain are the receptionist itself and can't be removed.
 */
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

/** Every module's on/off for a brand. No brand (the platform) → all on. A
 *  key that was never written is on: switching a module off is the deliberate
 *  act, so a brand created before a module existed keeps getting it. */
export function brandModules(brand: Brand | null | undefined): BrandModules {
  const raw = isPlainObject(brand?.modules) ? brand!.modules : {};
  const out = {} as BrandModules;
  for (const m of BRAND_MODULES) out[m.id] = (raw as Record<string, unknown>)[m.id] !== false;
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

/** Whether a stranger may create an account on this brand's front door. A
 *  brand may close its door and hand out accounts itself. The platform's own
 *  door (no brand) is never open: every customer belongs to a brand, so a
 *  sign-up there would have nowhere to go. */
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

/** A bare "acmevoice.com" is what people paste; make it a URL, then insist it
 *  really is one and is http(s) — a "javascript:" link in an email footer is
 *  not a typo anyone should be able to make. */
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

/**
 * Validate and normalise the setup half of a brand payload. Only keys that
 * were actually sent come back, so the same function serves create (where
 * Prisma's defaults fill the rest) and update (where untouched columns stay
 * untouched).
 */
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
  return data;
}
