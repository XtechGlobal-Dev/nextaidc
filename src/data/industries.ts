/**
 * Industry / niche options for the AI Brain → Identity section's
 * "Industry / Niche" dropdown. Plain display strings — the selected value is
 * stored verbatim on `profile.industry` and fed to the assistant's regional &
 * industry context (e.g. "a Plumbing business based in Australia"), so keep the
 * labels natural. Ordered by broad category. Adjust to taste — this is a
 * product list, not a fixed taxonomy.
 */
export const INDUSTRIES: string[] = [
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

  "Other",
];

/* ------------------------------------------------------------------ *
 *  Custom-industry validation — mirrors the server's sanitizeIndustry
 *  (server/src/lib/industries.ts) so the combobox can flag bad input
 *  instantly. The server always re-checks; this is UX only.
 * ------------------------------------------------------------------ */

export const INDUSTRY_MIN_LEN = 2;
export const INDUSTRY_MAX_LEN = 50;

// Letters (any script), digits, spaces, and a small set of punctuation real
// industry names use — deliberately excludes newlines, quotes, braces, etc.
const INDUSTRY_ALLOWED = /^[\p{L}\p{N} .,&/()'+-]+$/u;

/** Collapse whitespace + trim → the canonical display form. */
export function normalizeIndustry(raw: string): string {
  return raw.replace(/\s+/g, " ").trim();
}

/** Validate a proposed custom industry. Returns the cleaned value or an error. */
export function validateIndustry(raw: string): { value: string } | { error: string } {
  const value = normalizeIndustry(raw);
  if (!value) return { error: "Enter an industry name." };
  if (value.length < INDUSTRY_MIN_LEN)
    return { error: `Industry must be at least ${INDUSTRY_MIN_LEN} characters.` };
  if (value.length > INDUSTRY_MAX_LEN)
    return { error: `Industry must be ${INDUSTRY_MAX_LEN} characters or fewer.` };
  if (value.toLowerCase() === "other")
    return { error: 'Type your actual industry, not "Other".' };
  if (!INDUSTRY_ALLOWED.test(value))
    return { error: "Use only letters, numbers, spaces and . , & / ( ) ' + -" };
  if (!/\p{L}/u.test(value)) return { error: "Industry must include some letters." };
  return { value };
}
