import express from "express";
import multer from "multer";
import { z } from "zod";
import { prisma } from "../prisma.js";
import { requireAuth, requireSuperAdmin } from "../middleware/auth.js";
import { rateLimit } from "../middleware/rateLimit.js";
import { asyncHandler, badRequest } from "../lib/http.js";
import { audit } from "../services/audit.js";
import { sendTemplate } from "../services/email.js";
import { isStorageConfigured } from "../services/storage.js";
import { themeCatalog } from "../services/brands.js";
import { isStripeConfigured } from "../services/stripe.js";
import { listAddonPrices, listBrandPlans } from "../services/brandPlanCatalog.js";
import { adoptRequestCard } from "../services/brandBilling.js";
import {
  brandRequestOr404,
  checkRequestSlug,
  claimBrandRequest,
  completeBrandRequest,
  createRequestSetupIntent,
  declineBrandRequest,
  fileBrandRequest,
  releaseBrandRequest,
  serializeBrandRequest,
  REQUEST_LOGO_SLOTS,
  type RequestLogoSlot,
  type RequestUpload,
} from "../services/brandRequests.js";
import { brandBodySchema, brandLoginUrl, launchBrand } from "./brands.routes.js";

// Brand requests. Public side: the "Set up your brand" form files one. Super
// admin side: the Requested tab lists them, "Complete setup" creates the brand
// with the settings and permissions the super admin picks, or they decline it.

/* --------------------------------- Public -------------------------------- */

export const publicBrandRequestsRouter = express.Router();

/** Brand requests are the PLATFORM's funnel — a tenant's door must never sell
 *  brands on the platform's behalf. */
publicBrandRequestsRouter.use((req, _res, next) => {
  if (req.brand) next(badRequest("Brand requests are made on the platform's own site."));
  else next();
});

publicBrandRequestsRouter.get(
  "/slug-check",
  rateLimit({ windowMs: 60_000, max: 60 }),
  asyncHandler(async (req, res) => {
    res.json(await checkRequestSlug(String(req.query.slug ?? "")));
  }),
);

/** The palettes and typefaces a brand can pick from — the same catalog the super admin's editor uses —
 *  and whether logos can be uploaded on this server. */
publicBrandRequestsRouter.get(
  "/catalog",
  asyncHandler(async (_req, res) => {
    res.json({ ...themeCatalog(), uploadsEnabled: isStorageConfigured() });
  }),
);

/** The brand plans on offer, the add-ons a plan can be topped up with, and whether a card can be saved. */
publicBrandRequestsRouter.get(
  "/plans",
  asyncHandler(async (_req, res) => {
    const [plans, addons] = await Promise.all([listBrandPlans({ activeOnly: true }), listAddonPrices({ activeOnly: true })]);
    res.json({ plans, addons, paymentsEnabled: isStripeConfigured() });
  }),
);

/** The payment step's card form. Saves a card (no charge) on a fresh Stripe customer for the applicant. */
publicBrandRequestsRouter.post(
  "/setup-intent",
  rateLimit({ windowMs: 15 * 60_000, max: 10, message: "Too many attempts. Please try again in a few minutes." }),
  asyncHandler(async (req, res) => {
    const body = z
      .object({
        email: z.string().trim().email("Enter a valid email address").max(160),
        name: z.string().trim().min(2).max(80),
      })
      .parse(req.body);
    res.json(await createRequestSetupIntent(body));
  }),
);

// Logos arrive with the request itself. Raster only: these come from anyone on the internet, and an SVG
// can carry script — the super admin can still set an SVG at setup.
const PUBLIC_LOGO_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
  "image/x-icon",
  "image/vnd.microsoft.icon",
]);
const MAX_LOGO_BYTES = 2 * 1024 * 1024;
const logoUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_LOGO_BYTES, files: 3, fields: 4 },
  fileFilter: (_req, file, cb) => {
    if (PUBLIC_LOGO_TYPES.has(file.mimetype)) cb(null, true);
    else cb(badRequest("Logos must be PNG, JPG, WebP, GIF or ICO images."));
  },
}).fields((Object.keys(REQUEST_LOGO_SLOTS) as RequestLogoSlot[]).map((name) => ({ name, maxCount: 1 })));

/** multer, with its own errors (too big, too many) turned into a readable 400. */
const parseLogos: express.RequestHandler = (req, res, next) => {
  logoUpload(req, res, (err: unknown) => {
    if (!err) return next();
    if (err instanceof multer.MulterError) {
      return next(
        badRequest(err.code === "LIMIT_FILE_SIZE" ? "Each logo must be 2 MB or smaller." : "Those files couldn't be read."),
      );
    }
    next(err);
  });
};

const requestSchema = z.object({
  brandName: z.string().trim().min(2, "Brand name must be at least 2 characters").max(60),
  slug: z.string().trim().max(40).optional().default(""),
  tagline: z.string().trim().max(500).optional(),
  customDomain: z.string().trim().max(253).optional(),
  themePreset: z.string().trim().max(40).optional(),
  primaryColor: z.string().trim().max(7).optional(),
  accentColor: z.string().trim().max(7).optional(),
  fontFamily: z.string().trim().max(40).optional(),
  brandPlanId: z.string().trim().max(64).optional(),
  setupIntentId: z.string().trim().max(200).optional(),
  contactName: z.string().trim().min(2, "Enter your full name").max(80),
  email: z.string().trim().email("Enter a valid email address").max(160),
  phone: z.string().trim().max(40).optional(),
  country: z.string().trim().max(2).optional(),
  timezone: z.string().trim().max(64).optional(),
  notes: z.string().trim().max(1000).optional(),
  password: z.string().min(8, "Password must be at least 8 characters").max(200),
});

publicBrandRequestsRouter.post(
  "/",
  // A person files one request; a burst is a script.
  rateLimit({ windowMs: 15 * 60_000, max: 5, message: "Too many requests. Please try again in a few minutes." }),
  parseLogos,
  asyncHandler(async (req, res) => {
    // With logos the form is multipart: the fields ride as JSON in `data`. Without, plain JSON.
    let body: unknown = req.body;
    if (req.is("multipart/form-data")) {
      try {
        body = JSON.parse(String((req.body as { data?: unknown }).data ?? "{}"));
      } catch {
        throw badRequest("The request couldn't be read.");
      }
    }
    const files = (req.files ?? {}) as Partial<Record<RequestLogoSlot, RequestUpload[]>>;
    const logos: Partial<Record<RequestLogoSlot, RequestUpload>> = {};
    for (const slot of Object.keys(REQUEST_LOGO_SLOTS) as RequestLogoSlot[]) {
      const file = files[slot]?.[0];
      if (file) logos[slot] = file;
    }
    const request = await fileBrandRequest(requestSchema.parse(body), logos);
    res.status(201).json({
      id: request.id,
      brandName: request.brandName,
      slug: request.slug,
      email: request.email,
    });
  }),
);

/* ------------------------------- Super admin ------------------------------ */

export const superBrandRequestsRouter = express.Router();
superBrandRequestsRouter.use(requireAuth, requireSuperAdmin);

const STATUS_FILTER: Record<string, string[] | undefined> = {
  open: ["pending", "approving"],
  approved: ["approved"],
  declined: ["declined"],
  all: undefined,
};

superBrandRequestsRouter.get(
  "/brand-requests",
  asyncHandler(async (req, res) => {
    const key = String(req.query.status ?? "open");
    if (!(key in STATUS_FILTER)) throw badRequest("status must be open, approved, declined or all");
    const statuses = STATUS_FILTER[key];
    const [rows, grouped] = await Promise.all([
      prisma.brandRequest.findMany({
        where: statuses ? { status: { in: statuses } } : {},
        // Open ones oldest first — first come, first served; history newest first.
        orderBy: { createdAt: key === "open" ? "asc" : "desc" },
        take: 500,
      }),
      prisma.brandRequest.groupBy({ by: ["status"], _count: { _all: true } }),
    ]);
    const count = (s: string) => grouped.find((g) => g.status === s)?._count._all ?? 0;
    res.json({
      requests: rows.map(serializeBrandRequest),
      counts: {
        open: count("pending") + count("approving"),
        approved: count("approved"),
        declined: count("declined"),
      },
    });
  }),
);

superBrandRequestsRouter.get(
  "/brand-requests/:id",
  asyncHandler(async (req, res) => {
    res.json(serializeBrandRequest(await brandRequestOr404(req.params.id)));
  }),
);

// The same body "New brand" takes, minus the admin — the applicant IS the admin,
// with the password they chose — plus whether to tell them it's live.
const approveSchema = brandBodySchema.omit({ admin: true }).extend({
  notifyApplicant: z.boolean().optional().default(true),
});

superBrandRequestsRouter.post(
  "/brand-requests/:id/approve",
  asyncHandler(async (req, res) => {
    const { notifyApplicant, ...input } = approveSchema.parse(req.body);
    const actorId = req.user!.sub;
    // Claimed before anything is created, so a second click (or a second
    // operator) can't create the brand twice.
    const request = await claimBrandRequest(req.params.id, actorId);

    let launched: Awaited<ReturnType<typeof launchBrand>>;
    try {
      launched = await launchBrand(
        input,
        actorId,
        request.passwordHash
          ? {
              email: request.email,
              fullName: request.contactName,
              passwordHash: request.passwordHash,
              welcome: notifyApplicant
                ? (brand, email) =>
                    sendTemplate("brand_request_approved", email, {
                      user_name: request.contactName,
                      user_email: email,
                      brand_name: brand.name,
                      brand_url: brandLoginUrl(brand),
                    })
                : undefined,
            }
          : undefined,
      );
    } catch (err) {
      // Nothing was created (a taken address, a bad colour…) — hand the request
      // back so the setup can be fixed and retried.
      await releaseBrandRequest(request.id);
      throw err;
    }

    const { brand, payload } = launched;
    await completeBrandRequest(request.id, brand.id, actorId);

    // Their saved card becomes the brand's, and pays the first month now. A decline doesn't undo the
    // brand: its admin is asked to pay at first sign-in, and the super admin is told why.
    let billingError = "";
    if (request.stripeCustomerId && request.paymentMethodId && isStripeConfigured()) {
      try {
        await adoptRequestCard(brand.id, request);
      } catch (e) {
        billingError = `The brand is set up, but its card couldn't be charged (${
          e instanceof Error ? e.message : "payment failed"
        }). Its admin will be asked to pay when they first sign in.`;
      }
    }

    for (const [action, targetType, targetId] of [
      ["brand.create", "brand", brand.id],
      ["brand_request.approve", "brand_request", request.id],
    ] as const) {
      void audit({
        actorId,
        actorBrandId: req.user!.brandId ?? null,
        actorEmail: req.user!.email,
        action,
        targetType,
        targetId,
        metadata: { slug: brand.slug, name: brand.name, adminEmail: payload.admin?.email ?? null, requestId: request.id },
        ip: req.ip,
      });
    }

    res.status(201).json({
      ...payload,
      billingError,
      adminError:
        payload.adminError ||
        (request.passwordHash ? "" : "This request had no password on file, so no admin was created. Add one from the Team tab."),
    });
  }),
);

superBrandRequestsRouter.post(
  "/brand-requests/:id/decline",
  asyncHandler(async (req, res) => {
    const body = z
      .object({
        reason: z.string().trim().max(1000).optional().default(""),
        notify: z.boolean().optional().default(true),
      })
      .parse(req.body);
    const request = await declineBrandRequest(req.params.id, {
      reason: body.reason,
      actorId: req.user!.sub,
      notify: body.notify,
    });
    void audit({
      actorId: req.user!.sub,
      actorBrandId: req.user!.brandId ?? null,
      actorEmail: req.user!.email,
      action: "brand_request.decline",
      targetType: "brand_request",
      targetId: request.id,
      metadata: { name: request.brandName, email: request.email, reason: request.declineReason },
      ip: req.ip,
    });
    res.json(serializeBrandRequest(request));
  }),
);
