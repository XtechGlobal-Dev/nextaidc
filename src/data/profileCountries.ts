import { COUNTRIES } from "@/data/countries";

/**
 * Country / region options for the AI Brain → Identity section's
 * "Country / Region" dropdown. Derived from the canonical COUNTRIES list so
 * there's a single source of truth (no separate list to drift). `value` is the
 * ISO code (a stable React key); `label` is the display name — and the label is
 * what gets stored on `profile.country` and fed to the assistant's regional
 * context, so it reads naturally (e.g. "a business based in Australia").
 */
export const PROFILE_COUNTRIES: { value: string; label: string }[] = COUNTRIES.map((c) => ({
  value: c.code,
  label: c.name,
}));
