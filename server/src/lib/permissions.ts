export const CAPABILITIES = ["view", "create", "edit", "delete"] as const;
export type Capability = (typeof CAPABILITIES)[number];

export const CAPABILITY_LABELS: Record<Capability, string> = {
  view: "View",
  create: "Create",
  edit: "Edit",
  delete: "Delete",
};

/**
 * A field (table column) that can be individually gated inside a section.
 * Allow-list semantics: a role sees a column only when it holds the matching
 * `${section}.field.${key}` permission. The section's identity column (e.g. the
 * customer name) is always shown and is NOT listed here.
 */
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
    // A brand's customer support queue (ticket lane `support`). Unlike every
    // other section, holding these keys is only half the check: WHICH tickets a
    // staff member sees is decided by the departments granted to their role
    // (StaffRole.ticketDepartments) or to them personally. "edit" covers
    // replying and changing status / priority / assignee / department; "delete"
    // additionally covers moderating — removing someone else's message.
    key: "tickets",
    label: "Support Tickets",
    capabilities: ["view", "create", "edit", "delete"],
  },
  {
    // The platform's own inbox: the requests brand admins raise (lane `brand`).
    // Listed so the label exists in one place, but PLATFORM_ONLY_SECTIONS puts
    // it out of reach of everyone but the super admin — including STAFF, for
    // whom ticking the box would authorize nothing.
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
  // The Audit Log used to sit here. It is now platform-only (see
  // PLATFORM_ONLY_SECTIONS below), so it is no longer grantable — a ticked box
  // that authorizes nothing is worse than no box at all.
  //
  // Resellers is absent too, but for the opposite reason: it is open to every
  // ADMIN (a brand runs its own reseller programme) yet is deliberately NOT
  // staff-assignable, so there is no box to tick. Adding a SectionDef for it
  // here is all that would be needed to put it back in the staff matrix.
  //
  // Staff, Roles, Reports, Webhook Logs and System Health are ADMIN-only areas and
  // are intentionally NOT staff-assignable — they're excluded from the role
  // permission matrix. Every one of their pages/routes is gated by `requireAdmin`
  // (never `requirePermission`), so a STAFF member could never use them even if
  // the key were granted — a role that only ticked "Staff" would leave the member
  // with zero usable access ("no access yet"). Their pages remain accessible to
  // full ADMINs (who bypass permission checks).
  //
  // Platform Settings, the API Center and Brands go one step further: they hold
  // the platform's own integration credentials and every tenant's setup, so they
  // are gated by `requireSuperAdmin` — out of reach of a brand ADMIN as well as
  // of STAFF.
];

/**
 * Sections that belong to a BRAND, not to the platform.
 *
 * These four are the day-to-day running of a tenant's own customer base — its
 * signup metrics, its customers, their subscriptions and the voices they may
 * pick from. They are the brand admin's job, and in a white-label setup one
 * brand's customer list is that brand's business, not something the platform
 * owner browses.
 *
 * So the SUPER_ADMIN is refused them (see requirePermission). Everyone else is
 * unaffected: an ADMIN still runs their tenant, and STAFF are still gated by
 * their role's grants exactly as before.
 */
export const BRAND_SCOPED_SECTIONS = new Set([
  "overview",
  "customers",
  "subscriptions",
  "voice_bank",
  // A tenant's customers talking to that tenant's own team. Its support inbox
  // is its customer list in conversation form, so the same rule applies: the
  // platform owner is refused it. Their own inbox is `brand_tickets` below.
  "tickets",
  // A brand's own charge on top of the platform's plans, and the wallet its
  // share lands in. The platform owner manages these FROM the brand's page.
  "pricing",
  "wallet",
]);

/**
 * Sections that belong to the PLATFORM, not to any one brand.
 *
 * The audit trail is the platform owner's: an audit log that a tenant's own
 * admin can read is a weak audit log. Only the SUPER_ADMIN gets it — which is
 * also why it is absent from the staff matrix above.
 *
 * The reseller/affiliate programme used to sit here too. It no longer does: a
 * brand recruits and pays its own resellers, so every ADMIN gets the section,
 * narrowed to their own tenant by `tenantScope` on the /resellers and
 * /commissions routes. A brand admin therefore never sees — or can edit, delete
 * or mark paid — another brand's resellers or commissions.
 *
 * The mirror image of BRAND_SCOPED_SECTIONS: that set is refused TO the super
 * admin, this one is refused to everyone else.
 */
export const PLATFORM_ONLY_SECTIONS = new Set(["audit"]);

/**
 * Sections worked by the platform's own TEAM: the super admin, and the support
 * staff they employ — accounts with no brand. The requests brand admins raise
 * with the platform are between that brand and the platform; a rival tenant's
 * admin, or a staff member of ANY tenant, has no business in that queue. So a
 * brand's admin is refused these outright, and a staff member is admitted only
 * with no brand and the key (see requirePermission).
 */
export const PLATFORM_TEAM_SECTIONS = new Set(["brand_tickets"]);

/**
 * Drop the keys an account cannot hold given whose team it is on.
 *
 * A brand's staff work the brand's customer queue (`tickets.*`) and never the
 * platform's inbox; the platform's own staff work the platform's inbox
 * (`brand_tickets.*`) and never a customer queue. Applied on every auth read
 * and at every write, so a role holding both sides' keys can't smuggle one
 * side's to the other.
 */
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

/**
 * Drop any permission keys that are no longer assignable — e.g. keys for a
 * section that was removed from the matrix. Applied on every auth read so a
 * removed section can't keep authorizing a role/user whose stored `permissions`
 * still contain its (now-orphaned) keys.
 */
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
