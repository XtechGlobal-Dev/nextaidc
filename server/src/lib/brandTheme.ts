/* ------------------------------------------------------------------ *
 *  Brand theme catalog — the colours and typefaces a brand can be set
 *  to, defined ONCE here and served to the admin UI via
 *  GET /api/super/brands/catalog. The picker never carries its own copy,
 *  so a palette added here appears in the UI and validates on save with
 *  no second edit and no chance of the two lists drifting apart.
 * ------------------------------------------------------------------ */

export interface ColorPreset {
  id: string;
  label: string;
  /** Brand hue — buttons, links, active nav. */
  primary: string;
  /** Secondary hue — highlights, badges, second chart series. */
  accent: string;
  /** One-line read on the mood, shown under the swatch. */
  note: string;
}

/** Ready-made palettes. Picking one fills primary + accent; a brand can
 *  still hand-pick either colour afterwards (which flips preset → "custom"). */
export const COLOR_PRESETS: ColorPreset[] = [
  { id: "ocean",     label: "Ocean",     primary: "#2C76ED", accent: "#7C5CFC", note: "Confident, default-safe blue" },
  { id: "indigo",    label: "Indigo",    primary: "#4F46E5", accent: "#0EA5E9", note: "Modern SaaS indigo" },
  { id: "violet",    label: "Violet",    primary: "#7C3AED", accent: "#EC4899", note: "Creative and premium" },
  { id: "emerald",   label: "Emerald",   primary: "#059669", accent: "#10B981", note: "Trades, health, finance" },
  { id: "teal",      label: "Teal",      primary: "#0D9488", accent: "#0891B2", note: "Calm and clinical" },
  { id: "amber",     label: "Amber",     primary: "#D97706", accent: "#F59E0B", note: "Warm, energetic, retail" },
  { id: "sunset",    label: "Sunset",    primary: "#EA580C", accent: "#F97316", note: "Bold and high-energy" },
  { id: "crimson",   label: "Crimson",   primary: "#DC2626", accent: "#F43F5E", note: "Urgent, emergency callouts" },
  { id: "rose",      label: "Rose",      primary: "#E11D48", accent: "#FB7185", note: "Beauty, hospitality, wellness" },
  { id: "graphite",  label: "Graphite",  primary: "#334155", accent: "#0EA5E9", note: "Understated corporate" },
  { id: "forest",    label: "Forest",    primary: "#166534", accent: "#65A30D", note: "Outdoors, landscaping, agriculture" },
  { id: "slate",     label: "Slate",     primary: "#475569", accent: "#7C3AED", note: "Legal, consulting, B2B services" },
  { id: "cobalt",    label: "Cobalt",    primary: "#1D4ED8", accent: "#06B6D4", note: "Logistics, tech, fintech" },
  { id: "coral",     label: "Coral",     primary: "#F43F5E", accent: "#FB923C", note: "Hospitality, food, lifestyle" },
  { id: "mustard",   label: "Mustard",   primary: "#CA8A04", accent: "#DC2626", note: "Home services, auto, construction" },
];

/** Set when the colours were hand-picked rather than taken from a preset. */
export const CUSTOM_PRESET_ID = "custom";

export type FontGroup = "business" | "classic";

export interface FontOption {
  id: string;
  label: string;
  group: FontGroup;
  /** Full CSS stack — what the client writes into --font-sans. */
  stack: string;
  /** Google Fonts family name; blank = a system face needing no web font. */
  googleFamily: string;
  note: string;
}

/**
 * Two families of typeface, because the two read very differently to a
 * customer: **Business** is the geometric/grotesque sans a software product
 * wears, **Classic** is the serif a law firm, clinic or established trade wears.
 */
export const FONTS: FontOption[] = [
  {
    id: "inter",
    label: "Inter",
    group: "business",
    stack: '"Inter", ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif',
    googleFamily: "Inter",
    note: "The platform default — neutral and highly legible",
  },
  {
    id: "dm-sans",
    label: "DM Sans",
    group: "business",
    stack: '"DM Sans", ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
    googleFamily: "DM Sans",
    note: "Friendly geometric sans",
  },
  {
    id: "plus-jakarta",
    label: "Plus Jakarta Sans",
    group: "business",
    stack: '"Plus Jakarta Sans", ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
    googleFamily: "Plus Jakarta Sans",
    note: "Crisp and contemporary",
  },
  {
    id: "manrope",
    label: "Manrope",
    group: "business",
    stack: '"Manrope", ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
    googleFamily: "Manrope",
    note: "Rounded, approachable, tech-forward",
  },
  {
    id: "poppins",
    label: "Poppins",
    group: "business",
    stack: '"Poppins", ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
    googleFamily: "Poppins",
    note: "Bold geometric — strong headings",
  },
  {
    id: "playfair",
    label: "Playfair Display",
    group: "classic",
    stack: '"Playfair Display", Georgia, "Times New Roman", serif',
    googleFamily: "Playfair Display",
    note: "High-contrast display serif — luxury",
  },
  {
    id: "merriweather",
    label: "Merriweather",
    group: "classic",
    stack: '"Merriweather", Georgia, "Times New Roman", serif',
    googleFamily: "Merriweather",
    note: "Sturdy serif built for screens",
  },
  {
    id: "lora",
    label: "Lora",
    group: "classic",
    stack: '"Lora", Georgia, "Times New Roman", serif',
    googleFamily: "Lora",
    note: "Warm, well-balanced book serif",
  },
  {
    id: "libre-baskerville",
    label: "Libre Baskerville",
    group: "classic",
    stack: '"Libre Baskerville", Georgia, "Times New Roman", serif',
    googleFamily: "Libre Baskerville",
    note: "Traditional and authoritative",
  },
  {
    id: "source-serif",
    label: "Source Serif 4",
    group: "classic",
    stack: '"Source Serif 4", Georgia, "Times New Roman", serif',
    googleFamily: "Source Serif 4",
    note: "Quiet serif that still reads as modern",
  },
];

const FONT_BY_ID = new Map(FONTS.map((f) => [f.id, f]));
const PRESET_BY_ID = new Map(COLOR_PRESETS.map((p) => [p.id, p]));

export function findFont(id: string): FontOption | undefined {
  return FONT_BY_ID.get(id);
}
export function findPreset(id: string): ColorPreset | undefined {
  return PRESET_BY_ID.get(id);
}

export const DEFAULT_FONT_ID = "inter";
export const DEFAULT_PRESET_ID = "ocean";

/** #RGB or #RRGGBB. */
const HEX_RE = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;
export function isHexColor(v: string): boolean {
  return HEX_RE.test(v.trim());
}

/* --------------------------------- Slugs --------------------------------- */

/**
 * Subdomain labels the platform needs for itself. A brand claiming one of these
 * would take over the marketing site, the API or the mail domain's well-known
 * hosts — so they're refused at create time rather than discovered later.
 */
export const RESERVED_SLUGS = new Set([
  "www", "api", "app", "admin", "dashboard", "portal", "mail", "smtp", "imap",
  "ftp", "cdn", "static", "assets", "status", "help", "support", "docs", "blog",
  "billing", "pay", "checkout", "auth", "login", "signup", "account", "accounts",
  "super", "superadmin", "root", "system", "internal", "staging", "dev", "test",
  "demo", "sandbox", "vapi", "webhook", "webhooks", "ns1", "ns2", "mx", "email",
]);

/** Lowercase, strip anything that isn't [a-z0-9-], collapse and trim dashes. */
export function normalizeSlug(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** Why a slug can't be used, or null when it's fine. */
export function slugProblem(slug: string): string | null {
  if (slug.length < 3) return "Subdomain must be at least 3 characters.";
  if (slug.length > 40) return "Subdomain must be 40 characters or fewer.";
  if (!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(slug)) {
    return "Subdomain may only contain lowercase letters, numbers and hyphens, and can't start or end with a hyphen.";
  }
  if (RESERVED_SLUGS.has(slug)) return `"${slug}" is reserved by the platform. Pick another subdomain.`;
  return null;
}
