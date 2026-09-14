export const CAPABILITIES = ["view", "create", "edit", "delete"] as const;
export type Capability = (typeof CAPABILITIES)[number];

export const CAPABILITY_LABELS: Record<Capability, string> = {
  view: "View",
  create: "Create",
  edit: "Edit",
  delete: "Delete",
};

/** A gatable table column (allow-list: shown only with `${section}.field.${key}`). The identity column is never listed. */
export interface FieldDef {
  key: string;
  label: string;
}

export interface SectionDef {
  key: string;
  label: string;
  capabilities: readonly Capability[];
  /** Column-level sub-permissions for the section's data table (optional). */
  fields?: readonly FieldDef[];
}

export const SECTIONS: SectionDef[] = [
  { key: "overview", label: "Overview", capabilities: ["view"] },
  { key: "customers", label: "Customers", capabilities: ["view", "create", "edit", "delete"] },
  {
    key: "subscriptions",
    label: "Subscriptions",
    capabilities: ["view", "edit"],
    fields: [
      { key: "plan", label: "Plan" },
      { key: "price", label: "Price" },
      { key: "status", label: "Status" },
      { key: "minutes", label: "Minutes" },
      { key: "renewal", label: "Renews / Ends" },
      { key: "autoRenew", label: "Auto-renew" },
      { key: "invoices", label: "Invoices & payments" },
    ],
  },
  {
    // Brand support queue. Keys are only half the check — WHICH tickets staff see comes from their
    // department grants. "delete" also covers moderating someone else's message.
    key: "tickets",
    label: "Support Tickets",
    capabilities: ["view", "create", "edit", "delete"],
  },
  {
    // Platform inbox for brand admins' requests. Listed for the label; access is gated by
    // PLATFORM_TEAM_SECTIONS, not by this row alone.
    key: "brand_tickets",
    label: "Brand Requests",
    capabilities: ["view", "create", "edit", "delete"],
  },
  { key: "plans", label: "Plans", capabilities: ["view", "create", "edit", "delete"] },
  { key: "coupons", label: "Coupons", capabilities: ["view", "create", "edit", "delete"] },
  { key: "voice_bank", label: "Voice Bank", capabilities: ["view", "create", "edit", "delete"] },
  { key: "phone_numbers", label: "Phone Numbers", capabilities: ["view", "create", "edit", "delete"] },
  { key: "emails", label: "System Emails", capabilities: ["view", "edit"] },
  { key: "pricing", label: "Pricing", capabilities: ["view", "edit"] },
  { key: "wallet", label: "Wallet", capabilities: ["view"] },
  // Not listed on purpose: audit (platform-only), resellers (every ADMIN, never staff), and the
  // requireAdmin/requireSuperAdmin areas — a grantable box that authorizes nothing is worse than none.
];

/** A tenant's own customer base — the SUPER_ADMIN is refused these (one brand's customers are not
 *  the platform owner's to browse). Everyone else is gated as before. */
export const BRAND_SCOPED_SECTIONS = new Set([
  "overview",
  "customers",
  "subscriptions",
  "voice_bank",
  // The support inbox is the customer list in conversation form; the platform's own is `brand_tickets`.
  "tickets",
  // Brand markup and its wallet — the platform owner manages these from the brand's page.
  "pricing",
  "wallet",
]);

/** Refused to everyone but the SUPER_ADMIN — an audit log a tenant admin can read is a weak audit log.
 *  Resellers moved out: each brand runs its own programme, tenant-scoped on the routes. */
export const PLATFORM_ONLY_SECTIONS = new Set(["audit"]);

/** Worked by the platform's own team (no brand). Brand admins are refused outright; staff need no
 *  brand plus the key — a rival tenant must never see another brand's requests. */
export const PLATFORM_TEAM_SECTIONS = new Set(["brand_tickets"]);

/** Drop the other side's ticket keys (brand staff: no `brand_tickets.*`; platform staff: no `tickets.*`).
 *  Applied on every auth read and write so a role holding both can't smuggle one across. */
export function scopePermissionsToTenant(
  permissions: string[],
  brandId: string | null | undefined,
): string[] {
  const banned = brandId ? "brand_tickets." : "tickets.";
  return permissions.filter((p) => !p.startsWith(banned));
}

export const SECTION_KEYS = SECTIONS.map((s) => s.key);

/** Every capability key, e.g. "customers.view". */
export const CAPABILITY_PERMISSION_KEYS: string[] = SECTIONS.flatMap((s) =>
  s.capabilities.map((c) => `${s.key}.${c}`),
);

/** Every field (column) key, e.g. "subscriptions.field.price". */
export const FIELD_PERMISSION_KEYS: string[] = SECTIONS.flatMap((s) =>
  (s.fields ?? []).map((f) => `${s.key}.field.${f.key}`),
);

/** All assignable permission keys — capabilities + field/column sub-permissions. */
export const ALL_PERMISSION_KEYS: string[] = [
  ...CAPABILITY_PERMISSION_KEYS,
  ...FIELD_PERMISSION_KEYS,
];

const ASSIGNABLE_KEY_SET = new Set(ALL_PERMISSION_KEYS);

/** Drop keys that are no longer assignable, so a removed section can't keep authorizing via stored orphans. */
export function sanitizePermissions(permissions: string[] | null | undefined): string[] {
  return (permissions ?? []).filter((p) => ASSIGNABLE_KEY_SET.has(p));
}

export function hasCapability(
  permissions: string[],
  section: string,
  capability: Capability = "view",
): boolean {
  return permissions.includes(`${section}.${capability}`);
}

/** Column-level check — true when the role may see the given table column. */
export function hasField(permissions: string[], section: string, field: string): boolean {
  return permissions.includes(`${section}.field.${field}`);
}

export function sectionPermissions(section: string): string[] {
  const def = SECTIONS.find((s) => s.key === section);
  if (!def) return [];
  return [
    ...def.capabilities.map((c) => `${section}.${c}`),
    ...(def.fields ?? []).map((f) => `${section}.field.${f.key}`),
  ];
}
