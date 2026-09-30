import {
  BRAND_MODULES,
  type Brand,
  type BrandInput,
  type BrandModuleId,
  type BrandModules,
  type BrandScripts,
  type SignupMode,
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
  /** May the brand's own admin set its plan addons? */
  addonEditable: boolean;
  /** Cap on the addon per cycle, in cents; null = no cap. */
  maxAddonCents: number | null;
  /** What the brand pays the platform each month, in minor units. */
  platformFeeCents: number;
  platformFeeCurrency: string;
  /** Modules sold as feature add-ons → monthly price in minor units. */
  featurePrices: Partial<Record<BrandModuleId, number>>;
  /** Monthly caps across the brand's customers; null = no cap. */
  monthlyMinuteLimit: number | null;
  monthlyAiLimit: number | null;
  /** The brand plan it pays the platform on; null = the billing fields above, set by hand. */
  brandPlanId: string | null;
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
  addonEditable: true,
  maxAddonCents: null,
  platformFeeCents: 0,
  platformFeeCurrency: "usd",
  featurePrices: {},
  monthlyMinuteLimit: null,
  monthlyAiLimit: null,
  brandPlanId: null,
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
    addonEditable: b.addonEditable ?? true,
    maxAddonCents: b.maxAddonCents ?? null,
    platformFeeCents: b.platformFeeCents ?? 0,
    platformFeeCurrency: b.platformFeeCurrency ?? "usd",
    featurePrices: b.featurePrices ?? {},
    monthlyMinuteLimit: b.monthlyMinuteLimit ?? null,
    monthlyAiLimit: b.monthlyAiLimit ?? null,
    brandPlanId: b.brandPlanId ?? null,
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
    addonEditable: d.addonEditable,
    maxAddonCents: d.maxAddonCents,
    platformFeeCents: d.platformFeeCents,
    platformFeeCurrency: d.platformFeeCurrency,
    featurePrices: d.featurePrices,
    monthlyMinuteLimit: d.monthlyMinuteLimit,
    monthlyAiLimit: d.monthlyAiLimit,
    brandPlanId: d.brandPlanId,
  };
}
