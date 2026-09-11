/**
 * Industry / niche taxonomy for the AI Brain → Identity "Industry / Niche" field.
 *
 * The selected value is stored verbatim on `profile.industry` and injected into the
 * assistant's prompt ("a {industry} business based in {country}"), so entries must
 * read naturally AND be safe to drop into a prompt. Customers can propose their own
 * industry when none fits; those go to an admin-approved queue (see settings.ts)
 * before joining the public list every customer sees.
 *
 * This built-in list is the server's source of truth for the public list; the
 * frontend keeps a copy only as an offline fallback.
 */
export const BUILTIN_INDUSTRIES: string[] = [
  // Trades & home services
  "Plumbing",
  "Electrical",
  "HVAC / Air Conditioning",
  "Carpentry & Joinery",
  "Painting & Decorating",
  "Landscaping & Gardening",
  "Cleaning Services",
  "Pest Control",
  "Locksmith",
  "Roofing",
  "Flooring & Tiling",
  "Handyman Services",
  "Pool & Spa Services",
  "Removalists & Moving",
  "Building & Construction",

  // Automotive
  "Auto Repair & Mechanic",
  "Car Detailing",
  "Panel Beating & Smash Repair",

  // Health & wellness
  "Medical / GP Clinic",
  "Dental",
  "Physiotherapy",
  "Chiropractic",
  "Psychology & Counselling",
  "Veterinary",
  "Optometry",
  "Podiatry",
  "Aged & Disability Care",

  // Beauty & personal care
  "Hair Salon",
  "Barbershop",
  "Beauty & Skin Clinic",
  "Nail Salon",
  "Massage Therapy",
  "Tattoo & Piercing",

  // Professional services
  "Accounting & Bookkeeping",
  "Legal / Law Firm",
  "Real Estate",
  "Insurance",
  "Financial Advisory",
  "Marketing & Advertising",
  "IT & Tech Support",
  "Consulting",
  "Recruitment & Staffing",

  // Hospitality, retail & events
  "Restaurant & Cafe",
  "Catering",
  "Event Planning",
  "Retail Store",
  "Fitness & Gym",
  "Photography & Videography",

  // Education
  "Tutoring & Education",
  "Childcare & Early Learning",
];

/** Length bounds for a custom industry label (chars, after trimming). */
export const INDUSTRY_MIN_LEN = 2;
export const INDUSTRY_MAX_LEN = 50;

// Letters (any script), digits, spaces, and a small set of punctuation real
// industry names use. Deliberately excludes newlines, control chars, quotes,
// backticks, braces, angle brackets etc. — the value is dropped into the live
// prompt, so this doubles as a guard against prompt-injection-y input.
const INDUSTRY_ALLOWED = /^[\p{L}\p{N} .,&/()'+-]+$/u;

/** Collapse runs of whitespace and trim — the canonical display form. */
export function normalizeIndustryWhitespace(raw: string): string {
  return raw.replace(/\s+/g, " ").trim();
}

/**
 * Validate + clean a proposed industry label. Returns the cleaned value, or an
 * `error` describing why it was rejected. The single authority for what counts as
 * a valid industry — the client mirrors these rules for instant feedback, but the
 * server always re-checks (never trust the client).
 */
export function sanitizeIndustry(raw: unknown): { value: string } | { error: string } {
  if (typeof raw !== "string") return { error: "Enter an industry name." };
  const value = normalizeIndustryWhitespace(raw);
  if (!value) return { error: "Enter an industry name." };
  if (value.length < INDUSTRY_MIN_LEN)
    return { error: `Industry must be at least ${INDUSTRY_MIN_LEN} characters.` };
  if (value.length > INDUSTRY_MAX_LEN)
    return { error: `Industry must be ${INDUSTRY_MAX_LEN} characters or fewer.` };
  if (value.toLowerCase() === "other")
    return { error: '"Other" isn\'t a valid industry — type your actual industry.' };
  if (!INDUSTRY_ALLOWED.test(value))
    return { error: "Use only letters, numbers, spaces and . , & / ( ) ' + -" };
  // Must contain at least one letter — reject "123" / "-- --" style noise.
  if (!/\p{L}/u.test(value)) return { error: "Industry must include some letters." };
  return { value };
}

/** Case-insensitive membership test against a list (uses the cleaned form). */
export function industryInList(value: string, list: string[]): boolean {
  const key = value.toLowerCase();
  return list.some((i) => i.toLowerCase() === key);
}
