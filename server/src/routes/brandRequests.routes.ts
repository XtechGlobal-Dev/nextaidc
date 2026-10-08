import express from "express";
import { z } from "zod";
import { prisma } from "../prisma.js";
import { requireAuth, requireSuperAdmin } from "../middleware/auth.js";
import { asyncHandler, badRequest } from "../lib/http.js";
import { audit } from "../services/audit.js";
import { serializeBrand } from "../services/brands.js";
import { approveAdminRequest, cancelPendingSetup } from "../services/brandLifecycle.js";
import {
  brandRequestOr404,
  claimBrandRequest,
  declineBrandRequest,
  releaseBrandRequest,
  serializeBrandRequest,
} from "../services/brandRequests.js";
import { brandBodySchema, brandLoginUrl } from "./brands.routes.js";

// Brand requests, super admin side: the Requested tab lists them, "Complete setup" approves one, or they decline it.
// Requests are filed from inside a main-domain customer's dashboard (brandAdminRequest.routes.ts); approving one
// turns that customer's OWN account into the brand (services/brandLifecycle.ts) — the only way a brand comes to be.
// A request left over from the retired public form (no applicant account) can only be declined.

/* ------------------------------- Super admin ------------------------------ */

export const superBrandRequestsRouter = express.Router();
superBrandRequestsRouter.use(requireAuth, requireSuperAdmin);

const STATUS_FILTER: Record<string, string[] | undefined> = {
  open: ["pending", "approving", "awaiting_domain"],
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
        open: count("pending") + count("approving") + count("awaiting_domain"),
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

// The brand's setup — door, look, settings — plus whether to tell the applicant it's live. The applicant's own
// account becomes the admin, so no admin is named here.
const approveSchema = brandBodySchema.extend({
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

    // A main-domain customer's request: their OWN account becomes the brand (docs/brand-as-customer-plan.md).
    if (request.applicantBrandId) {
      let outcome: Awaited<ReturnType<typeof approveAdminRequest>>;
      try {
        outcome = await approveAdminRequest(request, input, actorId);
      } catch (err) {
        await releaseBrandRequest(request.id);
        throw err;
      }
      void audit({
        actorId,
        actorBrandId: req.user!.brandId ?? null,
        actorEmail: req.user!.email,
        action: "brand_request.approve",
        targetType: "brand_request",
        targetId: request.id,
        metadata: { brandId: outcome.brand.id, slug: outcome.brand.slug, state: outcome.state },
        ip: req.ip,
      });
      const { pendingDomainCheck } = await import("../services/brandDomains.js");
      res.status(201).json({
        state: outcome.state,
        brand: serializeBrand(outcome.brand),
        loginUrl: brandLoginUrl(outcome.brand),
        domain: outcome.brand.customDomain ? pendingDomainCheck(outcome.brand) : null,
        // The shape the older create flow answered with, so the setup page reads both.
        admin: null,
        adminError: "",
        billingError: "",
      });
      return;
    }

    // From the retired public form: no customer account behind it, and a brand is never created from nothing.
    await releaseBrandRequest(request.id);
    throw badRequest(
      "This request came from the old public form and has no customer account behind it. Decline it — the applicant can sign up on the main site and ask from their dashboard.",
    );
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
    const before = await brandRequestOr404(req.params.id);
    const request = await declineBrandRequest(req.params.id, {
      reason: body.reason,
      actorId: req.user!.sub,
      notify: body.notify,
    });
    // Declined while waiting on the applicant's domain: give their row its customer look back.
    if (before.status === "awaiting_domain" && before.applicantBrandId) await cancelPendingSetup(before.applicantBrandId);
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
