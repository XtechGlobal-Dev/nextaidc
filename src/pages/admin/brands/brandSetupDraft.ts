import {
  BRAND_MODULES,
  type Brand,
  type BrandInput,
  type BrandModuleId,
  type BrandModules,
  type BrandScripts,
  type SignupMode,
  type SubscriptionPlan,
} from "@/lib/api";

// Editable "setup" half of a brand as the form holds it, plus brand → draft and draft → payload.

export interface SetupDraft {
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
  /** Null = use the platform's value. */
  trialDays: number | null;
  trialMinutes: number | null;
  cardRequired: boolean | null;
  defaultVoiceId: string;
  scripts: BrandScripts;
}

export const ALL_MODULES_ON = Object.fromEntries(
  BRAND_MODULES.map((m) => [m.id, true]),
) as BrandModules;

export const BLANK_SETUP: SetupDraft = {
  legalName: "",
  legalAddress: "",
  termsUrl: "",
  privacyUrl: "",
  websiteUrl: "",
  helpUrl: "",
  defaultCountry: "",
  defaultTimezone: "",
  signupMode: "public",
  loginHeadline: "",
  loginBlurb: "",
  modules: ALL_MODULES_ON,
  planIds: [],
  trialDays: null,
  trialMinutes: null,
  cardRequired: null,
  defaultVoiceId: "",
  scripts: { head: "", body: "", footer: "" },
};

export function setupFrom(b: Brand): SetupDraft {
  return {
    legalName: b.legalName ?? "",
    legalAddress: b.legalAddress ?? "",
    termsUrl: b.termsUrl ?? "",
    privacyUrl: b.privacyUrl ?? "",
    websiteUrl: b.websiteUrl ?? "",
    helpUrl: b.helpUrl ?? "",
    defaultCountry: b.defaultCountry ?? "",
    defaultTimezone: b.defaultTimezone ?? "",
    signupMode: b.signupMode ?? "public",
    loginHeadline: b.loginHeadline ?? "",
    loginBlurb: b.loginBlurb ?? "",
    modules: { ...ALL_MODULES_ON, ...(b.modules ?? {}) },
    planIds: b.planIds ?? [],
    trialDays: b.trialDays ?? null,
    trialMinutes: b.trialMinutes ?? null,
    cardRequired: b.cardRequired ?? null,
    defaultVoiceId: b.defaultVoiceId ?? "",
    scripts: b.scripts ?? { head: "", body: "", footer: "" },
  };
}

/** The setup half of a save payload — every field, so a cleared value is
 *  written as blank rather than silently kept. */
export function setupPayload(d: SetupDraft): Partial<BrandInput> {
  return {
    legalName: d.legalName,
    legalAddress: d.legalAddress,
    termsUrl: d.termsUrl,
    privacyUrl: d.privacyUrl,
    websiteUrl: d.websiteUrl,
    helpUrl: d.helpUrl,
    defaultCountry: d.defaultCountry,
    defaultTimezone: d.defaultTimezone,
    signupMode: d.signupMode,
    loginHeadline: d.loginHeadline,
    loginBlurb: d.loginBlurb,
    modules: d.modules,
    planIds: d.planIds,
    trialDays: d.trialDays,
    trialMinutes: d.trialMinutes,
    cardRequired: d.cardRequired,
    defaultVoiceId: d.defaultVoiceId,
    scripts: d.scripts,
  };
}

/* ------------------------- Modules ↔ plans on sale ------------------------ */

/** The plan add-on behind each module. A brand doesn't sell a plan whose add-on it has switched off — its customers
 *  would pay for something hidden from them. Booking has no plan add-on, so it never rules a plan out. */
const MODULE_PLAN_ADDON: Partial<Record<BrandModuleId, keyof SubscriptionPlan>> = {
  transfer: "callTransferEnabled",
  crm: "customCrmEnabled",
  smsToCaller: "smsToCallerEnabled",
  whatsapp: "whatsappEnabled",
};

/** The switched-off modules this plan includes an add-on for (empty = the brand can sell it). */
export function planBlockedBy(plan: SubscriptionPlan, modules: BrandModules): BrandModuleId[] {
  return (Object.keys(MODULE_PLAN_ADDON) as BrandModuleId[]).filter(
    (id) => modules[id] === false && plan[MODULE_PLAN_ADDON[id]!] === true,
  );
}

/** What to save as the brand's plans. An empty pick means "every active plan" to the server, so once a module
 *  rules some plans out, "every plan" is written out as the plans that still fit. */
export function plansOnSale(planIds: string[], modules: BrandModules, plans: SubscriptionPlan[]): string[] {
  const fits = plans.filter((p) => planBlockedBy(p, modules).length === 0);
  if (planIds.length) return planIds.filter((id) => fits.some((p) => p.id === id));
  return fits.length < plans.length ? fits.map((p) => p.id) : [];
}
