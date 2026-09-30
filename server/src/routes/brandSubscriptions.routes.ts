import express from "express";
import { z } from "zod";
import { requireAuth, requireSuperAdmin } from "../middleware/auth.js";
import { asyncHandler } from "../lib/http.js";
import { audit } from "../services/audit.js";
import {
  brandSubscriptionsOverview,
  createBrandPlan,
  deleteBrandPlan,
  listAddonPrices,
  listBrandPlans,
  saveAddonPrices,
  updateBrandPlan,
} from "../services/brandPlanCatalog.js";

// Brand Subscriptions (super admin): what BRANDS pay the PLATFORM — the brand plan catalog, the add-on list,
// and every brand's subscription. Deliberately apart from /admin/plans, which is what a brand sells ITS
// customers.

const router = express.Router();
router.use(requireAuth, requireSuperAdmin);

const planSchema = z.object({
  name: z.string().trim().min(2, "Give the plan a name").max(60),
  description: z.string().trim().max(500).optional(),
  priceCents: z.number().int().min(0).max(10_000_000),
  currency: z.string().trim().length(3),
  features: z.array(z.string().trim().max(40)).max(20),
  monthlyMinuteLimit: z.number().int().min(0).max(10_000_000).nullable().optional(),
  monthlyAiLimit: z.number().int().min(0).max(10_000_000).nullable().optional(),
  active: z.boolean().optional(),
  sortOrder: z.number().int().min(0).max(10_000).optional(),
  recommended: z.boolean().optional(),
  isDefault: z.boolean().optional(),
});

function auditPlan(req: express.Request, action: string, targetId: string, metadata: Record<string, unknown>) {
  void audit({
    actorId: req.user!.sub,
    actorBrandId: req.user!.brandId ?? null,
    actorEmail: req.user!.email,
    action,
    targetType: "brand_plan",
    targetId,
    metadata,
    ip: req.ip,
  });
}

router.get(
  "/brand-plans",
  asyncHandler(async (_req, res) => {
    res.json(await listBrandPlans({ withCounts: true }));
  }),
);

router.post(
  "/brand-plans",
  asyncHandler(async (req, res) => {
    const plan = await createBrandPlan(planSchema.parse(req.body));
    auditPlan(req, "brand_plan.create", plan.id, { name: plan.name, priceCents: plan.priceCents });
    res.status(201).json(plan);
  }),
);

router.patch(
  "/brand-plans/:id",
  asyncHandler(async (req, res) => {
    const body = planSchema.partial().parse(req.body);
    const plan = await updateBrandPlan(req.params.id, body);
    auditPlan(req, "brand_plan.update", plan.id, { fields: Object.keys(body) });
    res.json(plan);
  }),
);

router.delete(
  "/brand-plans/:id",
  asyncHandler(async (req, res) => {
    await deleteBrandPlan(req.params.id);
    auditPlan(req, "brand_plan.delete", req.params.id, {});
    res.json({ ok: true });
  }),
);

router.get(
  "/brand-addons",
  asyncHandler(async (_req, res) => {
    res.json(await listAddonPrices());
  }),
);

router.put(
  "/brand-addons",
  asyncHandler(async (req, res) => {
    const rows = z
      .array(
        z.object({
          moduleId: z.string().trim().max(40),
          priceCents: z.number().int().min(0).max(10_000_000),
          active: z.boolean(),
        }),
      )
      .max(20)
      .parse(req.body);
    const saved = await saveAddonPrices(rows);
    void audit({
      actorId: req.user!.sub,
      actorBrandId: req.user!.brandId ?? null,
      actorEmail: req.user!.email,
      action: "brand_addons.update",
      targetType: "platform",
      metadata: { addons: rows },
      ip: req.ip,
    });
    res.json(saved);
  }),
);

/** Every brand and what it pays, plus the headline numbers above the table. */
router.get(
  "/brand-subscriptions",
  asyncHandler(async (_req, res) => {
    const rows = await brandSubscriptionsOverview();
    // Monthly recurring revenue from brands, per currency — only subscriptions actually being paid.
    const mrr = new Map<string, number>();
    for (const r of rows) {
      if (r.billingStatus !== "active") continue;
      mrr.set(r.currency, (mrr.get(r.currency) ?? 0) + r.monthlyTotalCents);
    }
    res.json({
      rows,
      summary: {
        paying: rows.filter((r) => r.billingStatus === "active").length,
        awaiting: rows.filter((r) => r.billingStatus === "awaiting_card").length,
        failing: rows.filter((r) => r.billingStatus === "past_due" || r.billingStatus === "canceled").length,
        mrr: [...mrr.entries()].map(([currency, cents]) => ({ currency, cents })),
      },
    });
  }),
);

export default router;
