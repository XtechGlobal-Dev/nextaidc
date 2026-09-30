import express from "express";
import { z } from "zod";
import type { Request } from "express";
import { prisma } from "../prisma.js";
import { requireAuth, requirePermission } from "../middleware/auth.js";
import { asyncHandler, badRequest, forbidden } from "../lib/http.js";
import { listBrandPricing, setBrandAddon } from "../services/brandPricing.js";
import { listWalletEntries, walletBalances } from "../services/brandWallet.js";
import {
  activateBrandBilling,
  brandBillingView,
  buyFeature,
  cancelFeature,
  createBillingSetupIntent,
} from "../services/brandBilling.js";
import { isBrandModuleId } from "../services/brandSetup.js";
import { audit } from "../services/audit.js";

// A brand admin's own pricing and wallet. Always the signed-in account's brand — routes never take a brand id.
// Super admin is refused (they use /api/super); STAFF need the section on their role.

const router = express.Router();
router.use(requireAuth);

/** The brand this account runs. A platform-level admin has none, and so
 *  has no pricing of its own and no wallet. */
function ownBrandId(req: Request): string {
  const brandId = req.user?.brandId;
  if (!brandId) throw forbidden("This section belongs to a brand, not the platform.");
  return brandId;
}

router.get(
  "/pricing",
  requirePermission("pricing"),
  asyncHandler(async (req, res) => {
    const brandId = ownBrandId(req);
    const brand = await prisma.brand.findUnique({
      where: { id: brandId },
      select: { addonEditable: true, maxAddonCents: true },
    });
    res.json({
      rows: await listBrandPricing(brandId),
      addonEditable: brand?.addonEditable ?? false,
      maxAddonCents: brand?.maxAddonCents ?? null,
    });
  }),
);

const addonSchema = z.object({ addonCents: z.number().int().min(0).max(10_000_000) });

router.put(
  "/pricing/:planId",
  requirePermission("pricing", "edit"),
  asyncHandler(async (req, res) => {
    const { addonCents } = addonSchema.parse(req.body);
    const row = await setBrandAddon({
      brandId: ownBrandId(req),
      planId: req.params.planId,
      addonCents,
      // The brand's own hand: its editability switch and cap both apply.
      asBrand: true,
      actor: { id: req.user!.sub, email: req.user!.email, ip: req.ip },
    });
    res.json(row);
  }),
);

router.get(
  "/wallet",
  requirePermission("wallet"),
  asyncHandler(async (req, res) => {
    const brandId = ownBrandId(req);
    const [balances, entries] = await Promise.all([
      walletBalances(brandId),
      listWalletEntries(brandId),
    ]);
    res.json({ balances, entries });
  }),
);

/* -------------------------- Billing (brand → platform) -------------------------- */
// What the brand pays the platform: its fee and feature add-ons. Money leaves the brand here, so only
// its ADMIN — never staff, whatever their role grants.

function requireBrandAdmin(req: Request): string {
  const brandId = ownBrandId(req);
  if (req.user?.role !== "ADMIN") throw forbidden("Only the brand's administrator manages billing.");
  return brandId;
}

function auditBilling(req: Request, action: string, metadata: Record<string, unknown> = {}) {
  void audit({
    actorId: req.user!.sub,
    actorBrandId: req.user!.brandId ?? null,
    actorEmail: req.user!.email,
    action,
    targetType: "brand",
    targetId: req.user!.brandId ?? undefined,
    metadata,
    ip: req.ip,
  });
}

/** Status, card, add-ons, usage and invoices. Readable by any of the brand's admin-side accounts, so
 *  staff can see why the panel is locked; only the admin can act. */
router.get(
  "/billing",
  asyncHandler(async (req, res) => {
    res.json(await brandBillingView(ownBrandId(req), { invoices: req.user?.role === "ADMIN" }));
  }),
);

router.post(
  "/billing/setup-intent",
  asyncHandler(async (req, res) => {
    res.json(await createBillingSetupIntent(requireBrandAdmin(req), req.user!.email));
  }),
);

router.post(
  "/billing/activate",
  asyncHandler(async (req, res) => {
    const brandId = requireBrandAdmin(req);
    const { paymentMethodId } = z.object({ paymentMethodId: z.string().trim().min(1).max(200) }).parse(req.body);
    await activateBrandBilling(brandId, paymentMethodId);
    auditBilling(req, "brand_billing.activate");
    res.json(await brandBillingView(brandId, { invoices: true }));
  }),
);

function moduleParam(req: Request) {
  const id = req.params.moduleId;
  if (!isBrandModuleId(id)) throw badRequest("Unknown feature.");
  return id;
}

router.post(
  "/billing/features/:moduleId",
  asyncHandler(async (req, res) => {
    const brandId = requireBrandAdmin(req);
    const moduleId = moduleParam(req);
    await buyFeature(brandId, moduleId);
    auditBilling(req, "brand_billing.feature_buy", { module: moduleId });
    res.json(await brandBillingView(brandId, { invoices: true }));
  }),
);

router.delete(
  "/billing/features/:moduleId",
  asyncHandler(async (req, res) => {
    const brandId = requireBrandAdmin(req);
    const moduleId = moduleParam(req);
    await cancelFeature(brandId, moduleId);
    auditBilling(req, "brand_billing.feature_cancel", { module: moduleId });
    res.json(await brandBillingView(brandId, { invoices: true }));
  }),
);

export default router;
