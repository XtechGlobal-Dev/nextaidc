import express from "express";
import multer from "multer";
import { z } from "zod";
import type { Brand } from "@prisma/client";
import { prisma } from "../prisma.js";
import { requireAuth, requireSuperAdmin } from "../middleware/auth.js";
import { asyncHandler, badRequest, notFound } from "../lib/http.js";
import { appBaseUrl, platformSubdomainHost, platformSubdomainUrl } from "../env.js";
import { audit } from "../services/audit.js";
import { hashPassword } from "../lib/password.js";
import { ledgerSummary, listLedgerRows } from "../services/platformLedger.js";
import { listUnroutedEvents, resolveUnroutedEvent } from "../services/stripeUnrouted.js";
import { resolveStripeCustomer } from "../services/stripeCustomers.js";
import { runWithBrand } from "../lib/brandContext.js";
import { laneDb, tenantFor, TenantUnavailableError, type TenantClient } from "../services/tenantDb.js";
import { directoryCounts } from "../services/customerDirectory.js";
import { processStripeEvent } from "./billing.routes.js";
import type Stripe from "stripe";
import {
  assertDepartmentDeletable,
  assertDepartmentNameFree,
  departmentFieldsSchema,
  departmentInclude,
  serializeDepartment,
} from "../services/ticketDepartments.js";
import { forgetDepartmentScopes } from "../services/tickets.js";
import { sendTemplate } from "../services/email.js";
import { uploadObject, deleteObject, isStorageConfigured } from "../services/storage.js";
import { normalizeSlug, slugProblem } from "../lib/brandTheme.js";
import {
  provisionBrand,
  brandOrigin,
  createBrand,
  deleteBrand,
  loadBrands,
  serializeBrand,
  themeCatalog,
  updateBrand,
  type BrandView,
} from "../services/brands.js";
import {
  attachDomainToEdge,
  detachDomainFromEdge,
  isDomainProviderConfigured,
  pendingDomainCheck,
  verifyBrandDomain,
} from "../services/brandDomains.js";
import { platformApiOrigin } from "../lib/brandUrls.js";
import { isNeonConfigured, listRegions } from "../services/neonProjects.js";
import { checkBrandDatabase } from "../services/tenantProvisioning.js";
import { latestTenantMigration } from "../services/tenantMigrations.js";
import {
  applyBrandPriceToSubscribers,
  listBrandPricing,
  setBrandAddon,
} from "../services/brandPricing.js";
import {
  listWalletEntries,
  recordPayout,
  walletBalances,
  walletBalancesFor,
} from "../services/brandWallet.js";
import {
  BRAND_INTEGRATION_IDS,
  brandIntegrationsView,
  clearBrandIntegration,
  saveBrandIntegrations,
} from "../services/settings.js";

// White-label brand (tenant) control panel. requireSuperAdmin, not requireAdmin — a brand ADMIN must
// never create, inspect or re-theme another tenant, nor read any brand's messaging credentials.

const router = express.Router();
router.use(requireAuth, requireSuperAdmin);

/** Brand logo/favicon uploads — small images streamed straight to S3. */
const ALLOWED_IMAGE_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/svg+xml",
  "image/x-icon",
  "image/vnd.microsoft.icon",
  "image/gif",
]);
const assetUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 }, // 5 MB
  fileFilter: (_req, file, cb) => {
    if (ALLOWED_IMAGE_TYPES.has(file.mimetype)) cb(null, true);
    else cb(badRequest("Only PNG, JPEG, WebP, SVG, GIF or ICO images are allowed."));
  },
});

/** Which brand column each uploadable slot writes to. */
const ASSET_SLOTS = {
  logoLight: { column: "logoLightUrl", prefix: "brands/logo-light", label: "Light-mode logo" },
  logoDark: { column: "logoDarkUrl", prefix: "brands/logo-dark", label: "Dark-mode logo" },
  favicon: { column: "faviconUrl", prefix: "brands/favicon", label: "Favicon" },
} as const;
type AssetSlot = keyof typeof ASSET_SLOTS;
function isAssetSlot(v: string): v is AssetSlot {
  return Object.prototype.hasOwnProperty.call(ASSET_SLOTS, v);
}

/** Sign-in address: the wildcard-covered subdomain by default, the vanity domain only once VERIFIED — an unresolved hostname is worse than the one that works. */
export function brandLoginUrl(brand: Pick<Brand, "slug" | "customDomain" | "domainStatus">): string {
  return brandOrigin(brand as Brand) ?? `${appBaseUrl}/${brand.slug}`;
}

/** Path-routed address (`app.hello22.ai/acme`). Needs no DNS, so it still works on previews and in local dev. */
export function brandPathUrl(slug: string): string {
  return `${appBaseUrl}/${slug}`;
}

// Catalog. Declared BEFORE /:id so "catalog" and "slug-check" aren't read as brand ids.

/** Colour presets + font catalog the brand editor's pickers are built from. */
router.get(
  "/brands/catalog",
  asyncHandler(async (_req, res) => {
    res.json(themeCatalog());
  }),
);

/** Live subdomain availability for the create form. */
router.get(
  "/brands/slug-check",
  asyncHandler(async (req, res) => {
    const raw = String(req.query.slug ?? "");
    const exceptId = req.query.brandId ? String(req.query.brandId) : undefined;
    const slug = normalizeSlug(raw);
    const problem = slugProblem(slug);
    if (problem) {
      res.json({ slug, available: false, reason: problem, url: "" });
      return;
    }
    const existing = await prisma.brand.findUnique({ where: { slug } });
    const taken = !!existing && existing.id !== exceptId;
    res.json({
      slug,
      available: !taken,
      reason: taken ? `The address "${slug}" is already taken by another brand.` : "",
      url: platformSubdomainUrl(slug),
    });
  }),
);

/* --------------------------------- Brands -------------------------------- */

/** How many people each brand has. From the thin directory in Main (phase 5),
 *  so listing every brand opens no tenant. */
async function brandCounts(brandIds: string[]): Promise<Map<string, BrandView["counts"]>> {
  return directoryCounts(brandIds);
}

/** Setup gaps, each naming the tab that closes it. No vanity domain means no domain item — the subdomain is live on its own. */
/** Database summary for the brand page — no connection strings, no live round-trip (that's checkBrandDatabase). */
export async function tenantDbSummary(brandId: string) {
  const row = await prisma.brandDatabase.findUnique({ where: { brandId } });
  const latestVersion = latestTenantMigration();
  if (!row) {
    return {
      provisioned: false,
      status: "none" as const,
      provider: null,
      region: "",
      schemaName: "",
      neonProjectId: "",
      provisionedAt: null,
      migratedAt: null,
      schemaVersion: "",
      latestVersion,
      schemaCurrent: false,
      error: "",
    };
  }
  return {
    provisioned: true,
    status: row.status,
    provider: row.provider,
    region: row.region,
    schemaName: row.schemaName,
    neonProjectId: row.neonProjectId,
    provisionedAt: row.provisionedAt,
    migratedAt: row.migratedAt,
    schemaVersion: row.schemaVersion,
    latestVersion,
    schemaCurrent: row.schemaVersion === latestVersion,
    error: row.error,
  };
}

function brandReadiness(brand: Brand, counts?: BrandView["counts"]) {
  const integrations = brandIntegrationsView(brand.id);
  const email = integrations.find((i) => i.id === "email");
  const sms = integrations.find((i) => i.id === "twilio");
  const items = [
    {
      id: "database",
      label: "Database ready",
      done: brand.status !== "provisioning" && brand.status !== "failed",
      hint: "The brand's own database is still being set up — nothing works until it is.",
      tab: "brand",
    },
    {
      id: "admin",
      label: "An administrator can sign in",
      done: (counts?.admins ?? 0) > 0,
      hint: "Nobody can run this brand until it has an admin.",
      tab: "team",
    },
    {
      id: "logo",
      label: "Logo uploaded",
      done: Boolean(brand.logoLightUrl),
      hint: "Customers see the platform's logo until then.",
      tab: "whitelabel",
    },
    {
      id: "favicon",
      label: "Favicon uploaded",
      done: Boolean(brand.faviconUrl),
      hint: "The browser tab shows the platform's icon until then.",
      tab: "whitelabel",
    },
    {
      id: "email",
      label: "Own email sender",
      done: Boolean(email?.overridden),
      hint: "Emails go out from the platform's address until then.",
      tab: "whitelabel",
    },
    {
      id: "sms",
      label: "Own SMS sender",
      done: Boolean(sms?.overridden),
      hint: "Texts (OTP codes, call summaries) go out from the platform's Twilio number until then.",
      tab: "whitelabel",
    },
    {
      id: "legal",
      label: "Legal footer details",
      done: Boolean(brand.legalName) && Boolean(brand.termsUrl || brand.privacyUrl),
      hint: "Email footers need the tenant's legal name and its policy links.",
      tab: "content",
    },
    ...(brand.customDomain
      ? [
          {
            id: "domain",
            label: `${brand.customDomain} verified`,
            done: brand.domainStatus === "verified",
            hint: "The client still has to publish the two DNS records.",
            tab: "domain",
          },
        ]
      : []),
  ];
  return { items, done: items.filter((i) => i.done).length, total: items.length };
}

router.get(
  "/brands",
  asyncHandler(async (_req, res) => {
    const brands = await prisma.brand.findMany({ orderBy: { createdAt: "desc" } });
    const ids = brands.map((b) => b.id);
    const [counts, wallets] = await Promise.all([brandCounts(ids), walletBalancesFor(ids)]);
    res.json(
      brands.map((b) => ({
        ...serializeBrand(b, counts.get(b.id)),
        // What the platform currently owes each brand, per currency — so the
        // list answers "who needs paying" without opening every brand.
        walletBalances: wallets.get(b.id) ?? [],
      })),
    );
  }),
);

// Validate hex here: a bare length error is meaningless to someone who typed "red" and fires before the service's friendlier one.
const hexColor = z
  .string()
  .trim()
  .regex(/^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/, "Enter a hex colour like #2C76ED");

const themeSchema = {
  themePreset: z.string().trim().max(40).optional(),
  primaryColor: hexColor.optional(),
  accentColor: hexColor.optional(),
  fontFamily: z.string().trim().max(40).optional(),
  darkModeDefault: z.boolean().optional(),
};

// Shape only — brandSetup.ts does the real validation, so the operator gets one message, not two layers.
const setupSchema = {
  legalName: z.string().trim().max(200).optional(),
  legalAddress: z.string().trim().max(500).optional(),
  termsUrl: z.string().trim().max(500).optional(),
  privacyUrl: z.string().trim().max(500).optional(),
  websiteUrl: z.string().trim().max(500).optional(),
  helpUrl: z.string().trim().max(500).optional(),
  defaultCountry: z.string().trim().max(2).optional(),
  defaultTimezone: z.string().trim().max(64).optional(),
  signupMode: z.enum(["public", "invite"]).optional(),
  loginHeadline: z.string().trim().max(120).optional(),
  loginBlurb: z.string().trim().max(240).optional(),
  modules: z.record(z.boolean()).nullable().optional(),
  planIds: z.array(z.string().trim().max(64)).max(100).nullable().optional(),
  trialDays: z.number().int().min(0).max(365).nullable().optional(),
  trialMinutes: z.number().int().min(0).max(100_000).nullable().optional(),
  cardRequired: z.boolean().nullable().optional(),
  defaultVoiceId: z.string().trim().max(120).optional(),
  addonEditable: z.boolean().optional(),
  maxAddonCents: z.number().int().min(0).max(10_000_000).nullable().optional(),
  scripts: z
    .object({
      head: z.string().max(20_000).optional(),
      body: z.string().max(20_000).optional(),
      footer: z.string().max(20_000).optional(),
    })
    .nullable()
    .optional(),
};

const brandBodySchema = z.object({
  name: z.string().trim().min(2, "Brand name must be at least 2 characters").max(60),
  slug: z.string().trim().max(40).optional().default(""),
  // Optional here because the schema is shared with PATCH; POST enforces its own required version.
  customDomain: z.string().trim().max(120).optional().nullable(),
  status: z.enum(["active", "suspended"]).optional(),
  // The create form asks for this as "About / Description" — a paragraph, not
  // the one-liner the name suggests, so the cap is the form's 500.
  tagline: z.string().trim().max(500).optional(),
  supportEmail: z.string().trim().max(160).optional(),
  supportPhone: z.string().trim().max(40).optional(),
  logoLightUrl: z.string().trim().max(500).optional(),
  logoDarkUrl: z.string().trim().max(500).optional(),
  faviconUrl: z.string().trim().max(500).optional(),
  ...themeSchema,
  ...setupSchema,
  /** Optionally create the brand's administrator in the same step — this is how
   *  the "New brand" wizard works, so a brand is never left with no way in. */
  admin: z
    .object({
      email: z.string().trim().email("Enter a valid email address").max(160),
      fullName: z.string().trim().min(2, "Enter the admin's name").max(80),
      password: z.string().min(8, "Password must be at least 8 characters").max(200),
      /** Email the credentials to them (best-effort — never blocks creation). */
      sendWelcomeEmail: z.boolean().optional().default(true),
    })
    .optional(),
});

router.post(
  "/brands",
  asyncHandler(async (req, res) => {
    const body = brandBodySchema.parse(req.body);
    // A brand's address is set once at creation; slug and customDomain are locked out of PATCH.

    // Check the admin's email BEFORE creating the brand — otherwise a duplicate
    // address leaves an orphan tenant behind that the operator has to clean up.
    if (body.admin) {
      const existing = await prisma.user.findUnique({ where: { email: body.admin.email } });
      if (existing) {
        throw badRequest(
          `${body.admin.email} already has an account. Use a different address for this brand's admin.`,
        );
      }
    }

    const brand = await createBrand(
      { ...body, slug: body.slug || body.name, customDomain: body.customDomain ?? null },
      req.user!.sub,
    );

    // Register with the edge now so the cert is waiting when the client publishes DNS. Failure is reported, not fatal — the subdomain works regardless.
    let domainEdge = { ok: true, message: "" };
    if (brand.customDomain) domainEdge = await attachDomainToEdge(brand.customDomain);

    let adminCreated: { id: string; email: string; emailSent: boolean } | null = null;
    let adminError = "";
    // The admin lives in the just-provisioned brand DB. If that failed, the brand stands (Retry on its page) and the admin is added later.
    const tenant = body.admin ? await tenantFor(brand.id).catch(() => null) : null;
    if (body.admin && !tenant) {
      adminError =
        "The brand's database isn't ready, so the admin wasn't created. Retry the database, then add the admin from the Team tab.";
    }
    if (body.admin && tenant) {
      const user = await tenant.user.create({
        data: {
          email: body.admin.email,
          fullName: body.admin.fullName,
          passwordHash: await hashPassword(body.admin.password),
          role: "ADMIN",
        },
        select: { id: true, email: true },
      });
      let emailSent = false;
      if (body.admin.sendWelcomeEmail) {
        try {
          emailSent = await sendTemplate("brand_admin_welcome", user.email, {
            user_name: body.admin.fullName,
            user_email: user.email,
            password: body.admin.password,
            brand_name: brand.name,
            brand_url: brandLoginUrl(brand),
          });
        } catch {
          /* the account exists either way — a failed email must not undo it */
        }
      }
      adminCreated = { id: user.id, email: user.email, emailSent };
    }

    void audit({
      actorId: req.user!.sub,
      actorBrandId: req.user!.brandId ?? null,
      actorEmail: req.user!.email,
      action: "brand.create",
      targetType: "brand",
      targetId: brand.id,
      metadata: { slug: brand.slug, name: brand.name, adminEmail: adminCreated?.email ?? null },
      ip: req.ip,
    });

    res.status(201).json({
      brand: {
        ...serializeBrand(brand, { admins: adminCreated ? 1 : 0, customers: 0, total: adminCreated ? 1 : 0 }),
        tenantDb: await tenantDbSummary(brand.id),
      },
      admin: adminCreated,
      /** Why no admin was created although one was typed; empty otherwise. */
      adminError,
      loginUrl: brandLoginUrl(brand),
      pathUrl: brandPathUrl(brand.slug),
      // Present only when a vanity domain was named — the DNS the client has to
      // publish, handed back with the brand so the wizard can show it at once.
      domain: brand.customDomain
        ? {
            ...pendingDomainCheck(brand),
            ...domainPayload(brand),
            edgeOk: domainEdge.ok,
            edgeMessage: domainEdge.message,
          }
        : null,
    });
  }),
);

router.get(
  "/brands/:id",
  asyncHandler(async (req, res) => {
    const brand = await prisma.brand.findUnique({ where: { id: req.params.id } });
    if (!brand) throw notFound("Brand not found");
    const counts = await brandCounts([brand.id]);
    res.json({
      ...serializeBrand(brand, counts.get(brand.id)),
      loginUrl: brandLoginUrl(brand),
      pathUrl: brandPathUrl(brand.slug),
      readiness: brandReadiness(brand, counts.get(brand.id)),
      tenantDb: await tenantDbSummary(brand.id),
    });
  }),
);

router.patch(
  "/brands/:id",
  asyncHandler(async (req, res) => {
    // slug/customDomain are locked after creation — omitted (not ignored) so sneaking them in gets a clear rejection.
    const body = brandBodySchema.partial().omit({ admin: true, slug: true, customDomain: true }).parse(req.body);
    const brand = await updateBrand(req.params.id, body);
    void audit({
      actorId: req.user!.sub,
      actorBrandId: req.user!.brandId ?? null,
      actorEmail: req.user!.email,
      action: "brand.update",
      targetType: "brand",
      targetId: brand.id,
      metadata: { fields: Object.keys(body) },
      ip: req.ip,
    });
    const counts = await brandCounts([brand.id]);
    res.json({
      ...serializeBrand(brand, counts.get(brand.id)),
      loginUrl: brandLoginUrl(brand),
      pathUrl: brandPathUrl(brand.slug),
      readiness: brandReadiness(brand, counts.get(brand.id)),
    });
  }),
);

router.delete(
  "/brands/:id",
  asyncHandler(async (req, res) => {
    const brand = await prisma.brand.findUnique({ where: { id: req.params.id } });
    if (!brand) throw notFound("Brand not found");
    const members = await prisma.customerDirectory.count({ where: { brandId: brand.id } });
    // Hand the hostname back before the row goes, or it keeps resolving to this
    // deployment with no tenant behind it — and stays unclaimable by anyone else.
    if (brand.customDomain) await detachDomainFromEdge(brand.customDomain);
    await deleteBrand(brand.id);
    void audit({
      actorId: req.user!.sub,
      actorBrandId: req.user!.brandId ?? null,
      actorEmail: req.user!.email,
      action: "brand.delete",
      targetType: "brand",
      targetId: brand.id,
      // Worth recording: those accounts are still live, just no longer in a tenant.
      metadata: { slug: brand.slug, name: brand.name, membersDetached: members },
      ip: req.ip,
    });
    res.json({ ok: true, membersDetached: members });
  }),
);

// Brand domains. Only for a CLIENT-owned vanity domain (the subdomain is wildcard-covered and needs nothing here):
// we mint the proof token, register with the edge and hand back two records; the client pastes them into their registrar.

async function brandOr404(id: string): Promise<Brand> {
  const brand = await prisma.brand.findUnique({ where: { id } });
  if (!brand) throw notFound("Brand not found");
  return brand;
}

/** Domain panel payload. A brand domain serves the SPA only — API, webhooks and OAuth stay on the platform host, so there's nothing API-side to set up. */
function domainPayload(brand: Brand) {
  return {
    origin: brandOrigin(brand),
    platformHost: platformSubdomainHost(brand.slug),
    // Always the wildcard subdomain, even after a custom domain is verified — it must stay live. Carries the dev port on loopback.
    platformUrl: platformSubdomainUrl(brand.slug),
    pathUrl: brandPathUrl(brand.slug),
    apiOrigin: platformApiOrigin(),
    /** False → the operator must add the hostname in the hosting dashboard. */
    edgeAutomated: isDomainProviderConfigured(),
  };
}

/** Records to publish + claim status. Plain GET is stored state (pollable); `?live=1` really checks a PENDING claim first
 *  (stored state can't say which record landed), persists but isn't audited, and falls back to stored state on failure. */
router.get(
  "/brands/:id/domain",
  asyncHandler(async (req, res) => {
    const brand = await brandOr404(req.params.id);
    if (req.query.live === "1" && brand.customDomain && brand.domainStatus === "pending") {
      try {
        const check = await verifyBrandDomain(brand);
        const fresh = await brandOr404(brand.id);
        res.json({ ...check, ...domainPayload(fresh) });
        return;
      } catch {
        /* resolvers or DB unreachable — the stored verdict is still worth showing */
      }
    }
    res.json({ ...pendingDomainCheck(brand), ...domainPayload(brand) });
  }),
);

const domainSchema = z.object({ domain: z.string().trim().max(253) });

/** Claim a vanity domain. Edge registration happens HERE, not at verify: the cert needs the edge to know the host before
 *  the client's DNS points at it, and they'll point DNS as soon as we hand over records. Edge failure is reported, not thrown. */
router.put(
  "/brands/:id/domain",
  asyncHandler(async (req, res) => {
    const { domain } = domainSchema.parse(req.body);
    const before = await brandOr404(req.params.id);

    // Locked once claimed. This route only survives so brands created before the requirement can claim their one domain.
    if (before.customDomain) {
      throw badRequest(
        "This brand's custom domain is locked. Delete and recreate the brand to change it.",
      );
    }
    if (!domain.trim()) {
      throw badRequest("A custom domain is required.");
    }

    const brand = await updateBrand(before.id, { customDomain: domain });
    const edge = await attachDomainToEdge(brand.customDomain!);

    void audit({
      actorId: req.user!.sub,
      actorBrandId: req.user!.brandId ?? null,
      actorEmail: req.user!.email,
      action: "brand.domain.claim",
      targetType: "brand",
      targetId: brand.id,
      metadata: { domain: brand.customDomain, edgeOk: edge.ok },
      ip: req.ip,
    });

    res.json({
      ...pendingDomainCheck(brand),
      ...domainPayload(brand),
      edgeOk: edge.ok,
      edgeMessage: edge.message,
    });
  }),
);

/** Live DNS + edge check, persisted. This is what promotes a claim to `verified`, after which every brand link uses it. */
router.post(
  "/brands/:id/domain/verify",
  asyncHandler(async (req, res) => {
    const brand = await brandOr404(req.params.id);
    if (!brand.customDomain) throw badRequest("This brand has no custom domain to verify.");

    // Re-attach on every verify — the usual failure is a hostname never registered with the edge, so quietly fix it.
    const edge = await attachDomainToEdge(brand.customDomain);
    const check = await verifyBrandDomain(brand);

    void audit({
      actorId: req.user!.sub,
      actorBrandId: req.user!.brandId ?? null,
      actorEmail: req.user!.email,
      action: "brand.domain.verify",
      targetType: "brand",
      targetId: brand.id,
      metadata: { domain: brand.customDomain, status: check.status },
      ip: req.ip,
    });

    const fresh = await brandOr404(brand.id);
    res.json({
      ...check,
      ...domainPayload(fresh),
      // The check's edge verdict stands; an attach failure must not overwrite it (with no host token the
      // attach "fails" every run and a freshly verified domain would read as stuck on its cert).
      edgeMessage: edge.message,
    });
  }),
);

// Pricing & wallet, platform-owner view. Unlike brandAdmin.routes.ts, the super admin here isn't subject to the brand's editability or cap.

router.get(
  "/brands/:id/pricing",
  asyncHandler(async (req, res) => {
    const brand = await brandOr404(req.params.id);
    res.json({
      rows: await listBrandPricing(brand.id),
      addonEditable: brand.addonEditable,
      maxAddonCents: brand.maxAddonCents,
    });
  }),
);

const addonSchema = z.object({ addonCents: z.number().int().min(0).max(10_000_000) });

router.put(
  "/brands/:id/pricing/:planId",
  asyncHandler(async (req, res) => {
    const { addonCents } = addonSchema.parse(req.body);
    const brand = await brandOr404(req.params.id);
    const row = await setBrandAddon({
      brandId: brand.id,
      planId: req.params.planId,
      addonCents,
      asBrand: false,
      actor: { id: req.user!.sub, email: req.user!.email, ip: req.ip },
    });
    res.json(row);
  }),
);

/** Move the brand's existing subscribers on a plan onto its current Price. */
router.post(
  "/brands/:id/pricing/:planId/apply",
  asyncHandler(async (req, res) => {
    const brand = await brandOr404(req.params.id);
    res.json(
      await applyBrandPriceToSubscribers({
        brandId: brand.id,
        planId: req.params.planId,
        actor: { id: req.user!.sub, email: req.user!.email, ip: req.ip },
      }),
    );
  }),
);

/* ----------------------------- Money ------------------------------ */

/** The window a ledger question is asked over: `from`/`to` ISO dates, or the
 *  current calendar month. `to` is exclusive. */
function ledgerWindow(query: Record<string, unknown>): { from: Date; to: Date } {
  const parse = (v: unknown) => {
    if (typeof v !== "string" || !v) return null;
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? null : d;
  };
  const now = new Date();
  const from = parse(query.from) ?? new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const to = parse(query.to) ?? new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth() + 1, 1));
  if (to <= from) throw badRequest("`to` must be after `from`.");
  return { from, to };
}

/** What the platform earned in a window, overall and per brand — one grouped
 *  read of the ledger, however many brands. */
router.get(
  "/ledger",
  asyncHandler(async (req, res) => {
    const { from, to } = ledgerWindow(req.query as Record<string, unknown>);
    const summary = await ledgerSummary({ from, to });
    const brandIds = [...new Set(summary.byBrand.map((b) => b.brandId))];
    const brands = brandIds.length
      ? await prisma.brand.findMany({ where: { id: { in: brandIds } }, select: { id: true, name: true, slug: true } })
      : [];
    const nameById = new Map(brands.map((b) => [b.id, b]));
    res.json({
      from: from.toISOString(),
      to: to.toISOString(),
      totals: summary.totals,
      byBrand: summary.byBrand.map((b) => ({
        ...b,
        brandName: nameById.get(b.brandId)?.name ?? null,
        brandSlug: nameById.get(b.brandId)?.slug ?? null,
      })),
    });
  }),
);

/** One brand's payments: this window's totals and the most recent rows. */
router.get(
  "/brands/:id/ledger",
  asyncHandler(async (req, res) => {
    const brand = await brandOr404(req.params.id);
    const { from, to } = ledgerWindow(req.query as Record<string, unknown>);
    const [summary, rows] = await Promise.all([
      ledgerSummary({ from, to, brandId: brand.id }),
      listLedgerRows(brand.id),
    ]);
    res.json({ from: from.toISOString(), to: to.toISOString(), totals: summary.totals, rows });
  }),
);

/** Stripe events no brand could be found for. Never dropped: they wait here. */
router.get(
  "/stripe/unrouted",
  asyncHandler(async (_req, res) => {
    res.json({ events: await listUnroutedEvents() });
  }),
);

/** Try a parked event again — once the customer's account has been fixed so
 *  the index can place it. Applied exactly as the webhook would have. */
router.post(
  "/stripe/unrouted/:id/retry",
  asyncHandler(async (req, res) => {
    const row = await prisma.stripeUnroutedEvent.findUnique({ where: { id: req.params.id } });
    if (!row || row.resolvedAt) throw notFound("Parked event not found");
    const owner = await resolveStripeCustomer(row.stripeCustomerId);
    if (!owner) {
      throw badRequest(
        "No brand holds this Stripe customer yet. Give the customer's account its Stripe customer id, then retry.",
      );
    }
    await runWithBrand(owner.brandId, () => processStripeEvent(row.payload as unknown as Stripe.Event));
    await resolveUnroutedEvent(row.id, "routed", req.user!.sub);
    void audit({
      actorId: req.user!.sub,
      actorBrandId: req.user!.brandId ?? null,
      actorEmail: req.user!.email,
      action: "stripe.unrouted.retry",
      targetType: "stripeEvent",
      targetId: row.stripeEventId,
      metadata: { type: row.type, brandId: owner.brandId },
      ip: req.ip,
    });
    res.json({ ok: true, brandId: owner.brandId });
  }),
);

/** Put a parked event away without applying it — it was never ours. */
router.post(
  "/stripe/unrouted/:id/dismiss",
  asyncHandler(async (req, res) => {
    const row = await prisma.stripeUnroutedEvent.findUnique({ where: { id: req.params.id } });
    if (!row || row.resolvedAt) throw notFound("Parked event not found");
    await resolveUnroutedEvent(row.id, "dismissed", req.user!.sub);
    void audit({
      actorId: req.user!.sub,
      actorBrandId: req.user!.brandId ?? null,
      actorEmail: req.user!.email,
      action: "stripe.unrouted.dismiss",
      targetType: "stripeEvent",
      targetId: row.stripeEventId,
      metadata: { type: row.type },
      ip: req.ip,
    });
    res.json({ ok: true });
  }),
);

router.get(
  "/brands/:id/wallet",
  asyncHandler(async (req, res) => {
    const brand = await brandOr404(req.params.id);
    const [balances, entries] = await Promise.all([
      walletBalances(brand.id),
      listWalletEntries(brand.id),
    ]);
    res.json({ balances, entries });
  }),
);

const payoutSchema = z.object({
  amountCents: z.number().int().positive(),
  currency: z.string().trim().length(3),
  reference: z.string().trim().max(120).optional(),
  note: z.string().trim().max(500).optional(),
});

/** Record a payout the platform has made to the brand by hand. */
router.post(
  "/brands/:id/wallet/payouts",
  asyncHandler(async (req, res) => {
    const body = payoutSchema.parse(req.body);
    const brand = await brandOr404(req.params.id);
    const entry = await recordPayout({
      brandId: brand.id,
      ...body,
      actor: { id: req.user!.sub, email: req.user!.email, ip: req.ip },
    });
    res.status(201).json({ entry, balances: await walletBalances(brand.id) });
  }),
);

/* ------------------------- Brand assets (logos etc.) ---------------------- */

router.post(
  "/brands/:id/assets/:slot",
  assetUpload.single("file"),
  asyncHandler(async (req, res) => {
    const { id, slot } = req.params;
    if (!isAssetSlot(slot)) throw badRequest("Unknown brand asset slot.");
    if (!req.file) throw badRequest("No file uploaded.");
    if (!isStorageConfigured()) {
      throw badRequest("File storage isn't configured — set the S3 environment variables first.");
    }
    const brand = await prisma.brand.findUnique({ where: { id } });
    if (!brand) throw notFound("Brand not found");

    const def = ASSET_SLOTS[slot];
    const result = await uploadObject(
      `${def.prefix}/${brand.slug}`,
      req.file.buffer,
      req.file.mimetype,
      req.file.originalname,
    );
    const updated = await prisma.brand.update({
      where: { id },
      data: { [def.column]: result.url },
    });
    await loadBrands();
    void audit({
      actorId: req.user!.sub,
      actorBrandId: req.user!.brandId ?? null,
      actorEmail: req.user!.email,
      action: "brand.asset.upload",
      targetType: "brand",
      targetId: id,
      metadata: { slot, label: def.label },
      ip: req.ip,
    });
    res.json(serializeBrand(updated));
  }),
);

router.delete(
  "/brands/:id/assets/:slot",
  asyncHandler(async (req, res) => {
    const { id, slot } = req.params;
    if (!isAssetSlot(slot)) throw badRequest("Unknown brand asset slot.");
    const def = ASSET_SLOTS[slot];
    const brand = await prisma.brand.findUnique({ where: { id } });
    if (!brand) throw notFound("Brand not found");

    // Best-effort object cleanup: the URL is all we store, so derive the key
    // from it. A miss just leaves an orphan object — never block the clear.
    const url = brand[def.column];
    if (url) {
      const key = url.split("/").slice(3).join("/");
      if (key) await deleteObject(key).catch(() => undefined);
    }
    const updated = await prisma.brand.update({ where: { id }, data: { [def.column]: "" } });
    await loadBrands();
    res.json(serializeBrand(updated));
  }),
);

/* ------------------ Brand messaging (mail / SMS / WhatsApp) --------------- */

/** Masked view of what this brand overrides, and what it inherits. */
router.get(
  "/brands/:id/integrations",
  asyncHandler(async (req, res) => {
    const brand = await prisma.brand.findUnique({ where: { id: req.params.id } });
    if (!brand) throw notFound("Brand not found");
    res.json(brandIntegrationsView(brand.id));
  }),
);

router.put(
  "/brands/:id/integrations",
  asyncHandler(async (req, res) => {
    const brand = await prisma.brand.findUnique({ where: { id: req.params.id } });
    if (!brand) throw notFound("Brand not found");
    const updates = z.record(z.string(), z.string().max(4000)).parse(req.body ?? {});
    await saveBrandIntegrations(brand.id, updates);
    void audit({
      actorId: req.user!.sub,
      actorBrandId: req.user!.brandId ?? null,
      actorEmail: req.user!.email,
      action: "brand.integrations.save",
      targetType: "brand",
      targetId: brand.id,
      // Keys only — values are credentials and never belong in an audit row.
      metadata: { keys: Object.keys(updates) },
      ip: req.ip,
    });
    res.json(brandIntegrationsView(brand.id));
  }),
);

router.delete(
  "/brands/:id/integrations/:integrationId",
  asyncHandler(async (req, res) => {
    const { id, integrationId } = req.params;
    if (!(BRAND_INTEGRATION_IDS as readonly string[]).includes(integrationId)) {
      throw badRequest("That integration can't be white-labelled per brand.");
    }
    const brand = await prisma.brand.findUnique({ where: { id } });
    if (!brand) throw notFound("Brand not found");
    await clearBrandIntegration(brand.id, integrationId);
    void audit({
      actorId: req.user!.sub,
      actorBrandId: req.user!.brandId ?? null,
      actorEmail: req.user!.email,
      action: "brand.integrations.clear",
      targetType: "brand",
      targetId: brand.id,
      metadata: { integrationId },
      ip: req.ip,
    });
    res.json(brandIntegrationsView(brand.id));
  }),
);

/* ----------------------------- Brand admins ------------------------------ */

const adminView = {
  id: true,
  email: true,
  fullName: true,
  role: true,
  createdAt: true,
} as const;

router.get(
  "/brands/:id/admins",
  asyncHandler(async (req, res) => {
    // From the brand's own database. A brand still being set up has nobody yet.
    const rows = await tenantFor(req.params.id)
      .then((db) => db.user.findMany({ where: { role: { in: ["ADMIN", "STAFF"] } }, select: adminView, orderBy: { createdAt: "asc" } }))
      .catch((e: unknown) => {
        if (e instanceof TenantUnavailableError) return [];
        throw e;
      });
    res.json(
      rows.map((u) => ({
        id: u.id,
        email: u.email,
        fullName: u.fullName,
        role: u.role,
        createdAt: u.createdAt.toISOString(),
      })),
    );
  }),
);

router.post(
  "/brands/:id/admins",
  asyncHandler(async (req, res) => {
    const brand = await prisma.brand.findUnique({ where: { id: req.params.id } });
    if (!brand) throw notFound("Brand not found");
    const body = z
      .object({
        email: z.string().trim().email("Enter a valid email address").max(160),
        fullName: z.string().trim().min(2, "Enter the admin's name").max(80),
        password: z.string().min(8, "Password must be at least 8 characters").max(200),
        sendWelcomeEmail: z.boolean().optional().default(true),
      })
      .parse(req.body);

    // In the brand's own database — where the account will sign in. The same
    // email may exist in another brand: two brands, two accounts (decision Q1).
    const db = await tenantFor(brand.id);
    const existing = await db.user.findUnique({ where: { email: body.email } });
    if (existing) throw badRequest(`${body.email} already has an account in this brand.`);

    const user = await db.user.create({
      data: {
        email: body.email,
        fullName: body.fullName,
        passwordHash: await hashPassword(body.password),
        role: "ADMIN",
      },
      select: adminView,
    });

    let emailSent = false;
    if (body.sendWelcomeEmail) {
      try {
        emailSent = await sendTemplate("brand_admin_welcome", user.email, {
          user_name: body.fullName,
          user_email: user.email,
          password: body.password,
          brand_name: brand.name,
          brand_url: brandLoginUrl(brand),
        });
      } catch {
        /* account still created */
      }
    }

    void audit({
      actorId: req.user!.sub,
      actorBrandId: req.user!.brandId ?? null,
      actorEmail: req.user!.email,
      action: "brand.admin.create",
      targetType: "brand",
      targetId: brand.id,
      metadata: { email: user.email },
      ip: req.ip,
    });

    res.status(201).json({
      id: user.id,
      email: user.email,
      fullName: user.fullName,
      role: user.role,
      createdAt: user.createdAt.toISOString(),
      emailSent,
    });
  }),
);

/** Remove an admin from the brand. No "untenanted" state exists, so the account goes; with no workspace the plain delete is the whole teardown. */
router.delete(
  "/brands/:id/admins/:userId",
  asyncHandler(async (req, res) => {
    const db = await tenantFor(req.params.id);
    const user = await db.user.findUnique({ where: { id: req.params.userId } });
    if (!user) throw notFound("That admin isn't in this brand.");
    if (user.role !== "ADMIN") throw badRequest("Only a brand admin can be removed here.");
    if (user.id === req.user!.sub) throw badRequest("You can't remove your own account.");
    await db.user.delete({ where: { id: user.id } });
    void audit({
      actorId: req.user!.sub,
      actorBrandId: req.user!.brandId ?? null,
      actorEmail: req.user!.email,
      action: "brand.admin.delete",
      targetType: "brand",
      targetId: req.params.id,
      metadata: { email: user.email },
      ip: req.ip,
    });
    res.json({ ok: true });
  }),
);

// Dedicated tenant databases (data residency). SUPER_ADMIN only — moving data between regions is contractual, not a toggle. Every route audits.

/** Regions a tenant project can be created in — read live from Neon rather than
 *  hardcoded, so the picker can't offer a region the account cannot use. */
router.get(
  "/brands/tenant-db/regions",
  asyncHandler(async (_req, res) => {
    if (!isNeonConfigured()) {
      res.json({ configured: false, regions: [] });
      return;
    }
    res.json({ configured: true, regions: await listRegions() });
  }),
);

/** Current state of one brand's database, with a live health check. */
router.get(
  "/brands/:id/tenant-db",
  asyncHandler(async (req, res) => {
    const summary = await tenantDbSummary(req.params.id);
    if (!summary.provisioned) {
      res.json(summary);
      return;
    }
    // Connection strings are never returned, not even to a super admin, not even redacted.
    // Stored error = last provisioning failure; health error = does it answer now. Neither overwrites the other.
    const health = await checkBrandDatabase(req.params.id);
    res.json({ ...summary, health });
  }),
);

/** Retry database setup. Inline on purpose (the operator is watching); resumes the last attempt and never makes a second database. */
router.post(
  "/brands/:id/tenant-db",
  asyncHandler(async (req, res) => {
    const existing = await prisma.brand.findUnique({ where: { id: req.params.id } });
    if (!existing) throw notFound("Brand not found");
    if (existing.status === "active" || existing.status === "suspended") {
      throw badRequest("This brand's database is already set up.");
    }
    const brand = await provisionBrand(existing.id, "active");
    const tenantDb = await tenantDbSummary(brand.id);
    void audit({
      actorId: req.user!.sub,
      actorBrandId: req.user!.brandId ?? null,
      actorEmail: req.user!.email,
      action: "brand.tenantdb.provision",
      targetType: "brand",
      targetId: brand.id,
      metadata: { status: tenantDb.status, provider: tenantDb.provider, error: tenantDb.error },
      ip: req.ip,
    });
    const counts = await brandCounts([brand.id]);
    res.json({
      brand: {
        ...serializeBrand(brand, counts.get(brand.id)),
        loginUrl: brandLoginUrl(brand),
        pathUrl: brandPathUrl(brand.slug),
        readiness: brandReadiness(brand, counts.get(brand.id)),
        tenantDb,
      },
      tenantDb,
    });
  }),
);

// Support departments. Which queues exist is the platform's call; the brand admin only staffs them. All rows are lane `support`, owned by the brand.

/** A brand's customer queues live in that brand's own database (phase 4);
 *  managing them from here means opening it. */
async function brandDepartmentOr404(db: TenantClient, brandId: string, id: string) {
  const dept = await db.ticketDepartment.findFirst({
    where: { id, lane: "support", brandId },
  });
  if (!dept) throw notFound("Department not found");
  return dept;
}

router.get(
  "/brands/:id/ticket-departments",
  asyncHandler(async (req, res) => {
    const brand = await brandOr404(req.params.id);
    const db = await laneDb("support", brand.id);
    const rows = await db.ticketDepartment.findMany({
      where: { lane: "support", brandId: brand.id },
      orderBy: [{ order: "asc" }, { name: "asc" }],
      include: departmentInclude,
    });
    res.json(rows.map((d) => serializeDepartment(d, true)));
  }),
);

router.post(
  "/brands/:id/ticket-departments",
  asyncHandler(async (req, res) => {
    const brand = await brandOr404(req.params.id);
    const db = await laneDb("support", brand.id);
    const data = departmentFieldsSchema.parse(req.body);
    await assertDepartmentNameFree(db, "support", brand.id, data.name);
    const dept = await db.ticketDepartment.create({
      data: { ...data, lane: "support", brandId: brand.id },
      include: departmentInclude,
    });
    void audit({
      actorId: req.user!.sub,
      actorBrandId: req.user!.brandId ?? null,
      actorEmail: req.user!.email,
      action: "ticket_department.create",
      targetType: "ticketDepartment",
      targetId: dept.id,
      metadata: { brandId: brand.id, lane: "support", name: dept.name },
      ip: req.ip,
    });
    res.status(201).json(serializeDepartment(dept, true));
  }),
);

router.patch(
  "/brands/:id/ticket-departments/:deptId",
  asyncHandler(async (req, res) => {
    const brand = await brandOr404(req.params.id);
    const db = await laneDb("support", brand.id);
    const data = departmentFieldsSchema.partial().parse(req.body);
    const exists = await brandDepartmentOr404(db, brand.id, req.params.deptId);
    if (data.name && data.name !== exists.name) {
      await assertDepartmentNameFree(db, "support", brand.id, data.name, exists.id);
    }
    const dept = await db.ticketDepartment.update({
      where: { id: exists.id },
      data,
      include: departmentInclude,
    });
    void audit({
      actorId: req.user!.sub,
      actorBrandId: req.user!.brandId ?? null,
      actorEmail: req.user!.email,
      action: "ticket_department.update",
      targetType: "ticketDepartment",
      targetId: dept.id,
      metadata: { brandId: brand.id, ...data },
      ip: req.ip,
    });
    res.json(serializeDepartment(dept, true));
  }),
);

router.delete(
  "/brands/:id/ticket-departments/:deptId",
  asyncHandler(async (req, res) => {
    const brand = await brandOr404(req.params.id);
    const db = await laneDb("support", brand.id);
    const dept = await brandDepartmentOr404(db, brand.id, req.params.deptId);
    await assertDepartmentDeletable(db, dept);
    await db.ticketDepartment.delete({ where: { id: dept.id } });
    // Someone may have just lost the queue their grant named.
    forgetDepartmentScopes();
    void audit({
      actorId: req.user!.sub,
      actorBrandId: req.user!.brandId ?? null,
      actorEmail: req.user!.email,
      action: "ticket_department.delete",
      targetType: "ticketDepartment",
      targetId: dept.id,
      metadata: { brandId: brand.id, lane: "support", name: dept.name },
      ip: req.ip,
    });
    res.json({ ok: true });
  }),
);

export default router;
