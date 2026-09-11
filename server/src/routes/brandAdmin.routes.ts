import express from "express";
import { z } from "zod";
import type { Request } from "express";
import { prisma } from "../prisma.js";
import { requireAuth, requirePermission } from "../middleware/auth.js";
import { asyncHandler, forbidden } from "../lib/http.js";
import { listBrandPricing, setBrandAddon } from "../services/brandPricing.js";
import { listWalletEntries, walletBalances } from "../services/brandWallet.js";

/* ------------------------------------------------------------------ *
 *  A brand admin's own pricing and wallet.
 *
 *  Everything here is scoped to the signed-in account's brand and only
 *  that brand: the routes never take a brand id. "pricing" and "wallet"
 *  are brand-scoped sections (see lib/permissions.ts), so the super
 *  admin is refused here — the platform owner manages a brand's pricing
 *  from the brand's own page under /api/super — and STAFF need the
 *  section granted on their role.
 * ------------------------------------------------------------------ */

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

export default router;
