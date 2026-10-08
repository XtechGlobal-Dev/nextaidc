import express from "express";
import multer from "multer";
import { z } from "zod";
import { requireAuth } from "../middleware/auth.js";
import { rateLimit } from "../middleware/rateLimit.js";
import { asyncHandler, badRequest } from "../lib/http.js";
import { platformSubdomainHost } from "../env.js";
import { isStorageConfigured } from "../services/storage.js";
import { themeCatalog } from "../services/brands.js";
import { requestTenant } from "../services/tenantDb.js";
import {
  checkRequestSlug,
  fileBrandAdminRequest,
  REQUEST_LOGO_SLOTS,
  type RequestLogoSlot,
  type RequestUpload,
} from "../services/brandRequests.js";
import { latestAdminRequest, ownedCustomerRow, requestEligibilityProblem } from "../services/brandLifecycle.js";

// "Request Brand Admin" — a main-domain customer asks, from inside their own dashboard, for their account to become
// a white-label brand (docs/brand-as-customer-plan.md). The request is tied to the signed-in account; a super admin
// approves it, and the same account becomes the Brand Admin on the brand's own domain.

const router = express.Router();
router.use(requireAuth);

/** The account's main-domain row, or 403-style refusal for anyone else (brand accounts, staff, the platform). */
function applicantRow(req: express.Request) {
  return ownedCustomerRow(req.user!.brandId, req.user!.sub);
}

/** Where the account stands: may it ask, and what happened to its latest request. */
router.get(
  "/",
  asyncHandler(async (req, res) => {
    const row = applicantRow(req);
    const [problem, request] = await Promise.all([
      requestEligibilityProblem(row.id, req.user!.sub),
      latestAdminRequest(row.id),
    ]);
    // Approved and waiting on their own domain: the records they still have to publish.
    let dns: { type: string; fqdn: string; value: string }[] = [];
    if (request?.status === "awaiting_domain" && row.customDomain) {
      const { domainInstructions } = await import("../services/brandDomains.js");
      dns = domainInstructions(row).map((r) => ({ type: r.type, fqdn: r.fqdn, value: r.value }));
    }
    res.json({
      eligible: !problem,
      reason: problem ?? "",
      subdomainSuffix: platformSubdomainHost("x").slice(1),
      request: request
        ? {
            id: request.id,
            status: request.status,
            brandName: request.brandName,
            slug: request.slug,
            customDomain: request.customDomain,
            declineReason: request.declineReason,
            createdAt: request.createdAt.toISOString(),
            reviewedAt: request.reviewedAt?.toISOString() ?? null,
            domainStatus: request.status === "awaiting_domain" ? row.domainStatus : null,
            domainError: request.status === "awaiting_domain" ? row.domainError : "",
            dns,
          }
        : null,
    });
  }),
);

router.get(
  "/slug-check",
  rateLimit({ windowMs: 60_000, max: 60 }),
  asyncHandler(async (req, res) => {
    applicantRow(req);
    res.json(await checkRequestSlug(String(req.query.slug ?? "")));
  }),
);

/** The palettes and typefaces a brand can pick from, and whether logos can be uploaded here. */
router.get(
  "/catalog",
  asyncHandler(async (req, res) => {
    applicantRow(req);
    res.json({ ...themeCatalog(), uploadsEnabled: isStorageConfigured() });
  }),
);

// Raster only — an SVG can carry script; the super admin can still set one at setup.
const LOGO_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif", "image/x-icon", "image/vnd.microsoft.icon"]);
const logoUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 2 * 1024 * 1024, files: 3, fields: 4 },
  fileFilter: (_req, file, cb) => {
    if (LOGO_TYPES.has(file.mimetype)) cb(null, true);
    else cb(badRequest("Logos must be PNG, JPG, WebP, GIF or ICO images."));
  },
}).fields((Object.keys(REQUEST_LOGO_SLOTS) as RequestLogoSlot[]).map((name) => ({ name, maxCount: 1 })));

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
  phone: z.string().trim().max(40).optional(),
  notes: z.string().trim().max(1000).optional(),
});

router.post(
  "/",
  rateLimit({ windowMs: 15 * 60_000, max: 5, message: "Too many requests. Please try again in a few minutes." }),
  parseLogos,
  asyncHandler(async (req, res) => {
    const row = applicantRow(req);
    const problem = await requestEligibilityProblem(row.id, req.user!.sub);
    if (problem) throw badRequest(problem);

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

    const db = await requestTenant(req);
    const [me, profile] = await Promise.all([
      db.user.findUnique({ where: { id: req.user!.sub }, select: { email: true, fullName: true } }),
      db.profile.findUnique({ where: { userId: req.user!.sub }, select: { mobile: true, timezone: true } }),
    ]);
    if (!me) throw badRequest("Your account couldn't be read. Please sign in again.");
    const input = requestSchema.parse(body);
    const request = await fileBrandAdminRequest(
      {
        brandId: row.id,
        userId: req.user!.sub,
        email: me.email,
        fullName: me.fullName,
        timezone: profile?.timezone ?? "",
      },
      { ...input, phone: input.phone || profile?.mobile || "" },
      logos,
    );
    res.status(201).json({ id: request.id, status: request.status, brandName: request.brandName });
  }),
);

export default router;
