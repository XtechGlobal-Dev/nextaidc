import { COUNTRIES } from "@/data/countries";

/** Country dropdown options, derived from COUNTRIES so nothing drifts. The label (not the ISO code)
 *  is what's stored on `profile.country` and read into the prompt. */
export const PROFILE_COUNTRIES: { value: string; label: string }[] = COUNTRIES.map((c) => ({
  value: c.code,
  label: c.name,
}));
