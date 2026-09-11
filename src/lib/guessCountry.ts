import { parsePhoneNumberFromString } from "libphonenumber-js/max";
import { COUNTRIES } from "@/data/countries";

/** Short country aliases a formal name misses ("USA" for United States). Kept
 *  tiny and matched whole-word, so they can't false-match inside another word. */
const COUNTRY_ALIASES: { alias: string; code: string }[] = [
  { alias: "usa", code: "us" },
  { alias: "u.s.a", code: "us" },
  { alias: "u.s", code: "us" },
  { alias: "uk", code: "gb" },
  { alias: "u.k", code: "gb" },
  { alias: "uae", code: "ae" },
];

/** Last whole-word index of `needle` in `hay` (-1 if absent). Whole-word so
 *  "India" doesn't match inside "Indiana"; last, because a country sits at the
 *  END of an address. */
function lastWordIndex(hay: string, needle: string): number {
  const re = new RegExp(`\\b${needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "gi");
  let idx = -1;
  for (let m = re.exec(hay); m; m = re.exec(hay)) idx = m.index;
  return idx;
}

/** Best-guess the profile country NAME for a newly-onboarded user. The business
 *  address wins (a country named in it is the strongest signal); when the address
 *  is missing or names no country, fall back to the mobile number's dial country.
 *  Returns "" when neither resolves. The returned name matches the AI Brain's
 *  country picker options (COUNTRIES[].name), so it can be stored on profile.country. */
export function guessProfileCountry(address: string | undefined, mobile: string | undefined): string {
  const addr = (address ?? "").toLowerCase();
  if (addr) {
    const candidates: { name: string; needle: string }[] = [
      ...COUNTRIES.map((c) => ({ name: c.name, needle: c.name.toLowerCase() })),
      ...COUNTRY_ALIASES.map(({ alias, code }) => ({
        name: COUNTRIES.find((x) => x.code === code)?.name ?? "",
        needle: alias,
      })),
    ].filter((x) => x.name);
    let bestName = "";
    let bestAt = -1;
    for (const { name, needle } of candidates) {
      const at = lastWordIndex(addr, needle);
      if (at > bestAt) {
        bestAt = at;
        bestName = name;
      }
    }
    if (bestName) return bestName;
  }
  const iso = parsePhoneNumberFromString((mobile ?? "").trim())?.country?.toLowerCase();
  return (iso && COUNTRIES.find((c) => c.code === iso)?.name) || "";
}
