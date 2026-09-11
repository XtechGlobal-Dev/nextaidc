import {
  BRAND_MODULES,
  type Brand,
  type BrandInput,
  type BrandModules,
  type BrandScripts,
  type SignupMode,
} from "@/lib/api";

/* ------------------------------------------------------------------ *
 *  The editable "setup" half of a brand — policies, legal identity,
 *  content — as the admin form holds it, and the two conversions the
 *  form needs: brand → draft on load, draft → payload on save.
 * ------------------------------------------------------------------ */

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
  };
}
