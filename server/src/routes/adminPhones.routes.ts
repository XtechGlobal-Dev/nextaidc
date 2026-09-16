import express from "express";
import { z } from "zod";
import { asyncHandler, HttpError } from "../lib/http.js";
import { requireAuth, requireAdminOrStaff, requirePermission } from "../middleware/auth.js";
import { audit } from "../services/audit.js";
import {
  getOverview,
  listAgents,
  twilioAvailable,
  twilioSearch,
  addSystem,
  reassign,
  assignSmsSender,
  unassignSmsSender,
  sendTestSms,
  cleanupOrphaned,
  clearSync,
  numberBrandId,
  resyncTwilio,
  getReplenishConfig,
  setReplenishConfig,
  replenishPool,
} from "../services/phones.js";

const router = express.Router();
router.use(requireAuth, requireAdminOrStaff, requirePermission("phone_numbers"));

/* ------------------------------- Read ------------------------------- */

/** The acting admin's tenant, or null for a platform-level admin — the same
 *  rule as `tenantScope()`: belong to a brand and you see only that brand. */
const viewerBrand = (req: express.Request): string | null => req.user?.brandId ?? null;

router.get(
  "/overview",
  asyncHandler(async (req, res) => {
    res.json(await getOverview(viewerBrand(req)));
  }),
);

router.get(
  "/agents",
  asyncHandler(async (req, res) => {
    res.json(await listAgents(viewerBrand(req)));
  }),
);

router.get(
  "/twilio-available",
  asyncHandler(async (_req, res) => {
    res.json(await twilioAvailable());
  }),
);

router.get(
  "/twilio-search",
  asyncHandler(async (req, res) => {
    const { country, areaCode, contains, type, prefix } = z
      .object({
        country: z.string().optional(),
        areaCode: z.string().optional(),
        contains: z.string().optional(),
        type: z.enum(["local", "mobile"]).optional(),
        prefix: z.string().optional(),
      })
      .parse(req.query);
    res.json(await twilioSearch({ country, areaCode, contains, type, prefix }));
  }),
);

/* ------------------------------ Mutations ------------------------------ */
router.post(
  "/add-system",
  requirePermission("phone_numbers", "create"),
  asyncHandler(async (req, res) => {
    const { number, sid, purchase } = z
      .object({ number: z.string(), sid: z.string().optional(), purchase: z.boolean().optional() })
      .parse(req.body);
    const created = await addSystem({ number, sid, purchase });
    void audit({
      actorId: req.user!.sub,
      actorBrandId: req.user!.brandId ?? null,
      actorEmail: req.user!.email,
      action: purchase ? "phones.purchase" : "phones.import",
      targetType: "phoneNumber",
      targetId: created.id,
      metadata: { number },
      ip: req.ip,
    });
    res.json(created);
  }),
);

router.post(
  "/:id/reassign",
  requirePermission("phone_numbers", "edit"),
  asyncHandler(async (req, res) => {
    const { agentId, brandId: agentBrandId } = z
      .object({ agentId: z.string().optional(), brandId: z.string().optional() })
      .parse(req.body ?? {});
    // Tenant wall — a direct call only needs an id. Not canReachBrand() on purpose:
    // the shared pool (brandId null) is inventory any brand may use, but never another tenant's.
    const rowBrand = await numberBrandId(req.params.id);
    const mine = viewerBrand(req);
    if (mine && rowBrand !== null && rowBrand !== mine) {
      throw new HttpError(404, "Phone number not found");
    }
    // The agent lives in a brand's database: a brand admin's own, or the one
    // the platform owner picked it from (listAgents names each agent's brand).
    const targetBrand = viewerBrand(req) ?? agentBrandId ?? null;
    if (agentId && !targetBrand) throw new HttpError(400, "Say which brand the agent belongs to.");
    await reassign(req.params.id, agentId && targetBrand ? { conversionId: agentId, brandId: targetBrand } : null, viewerBrand(req));
    void audit({
      actorId: req.user!.sub,
      actorBrandId: req.user!.brandId ?? null,
      actorEmail: req.user!.email,
      action: agentId ? "phones.assign" : "phones.toPool",
      targetType: "phoneNumber",
      targetId: req.params.id,
      metadata: { agentId: agentId ?? null },
      ip: req.ip,
    });
    res.json(await getOverview(viewerBrand(req)));
  }),
);

router.post(
  "/assign-sms",
  requirePermission("phone_numbers", "edit"),
  asyncHandler(async (req, res) => {
    const { number } = z.object({ number: z.string() }).parse(req.body);
    const sender = await assignSmsSender(number);
    void audit({
      actorId: req.user!.sub,
      actorBrandId: req.user!.brandId ?? null,
      actorEmail: req.user!.email,
      action: "phones.smsSender.set",
      targetType: "setting",
      metadata: { number: sender },
      ip: req.ip,
    });
    res.json({ smsSender: sender });
  }),
);

router.post(
  "/unassign-sms",
  requirePermission("phone_numbers", "edit"),
  asyncHandler(async (req, res) => {
    await unassignSmsSender();
    void audit({
      actorId: req.user!.sub,
      actorBrandId: req.user!.brandId ?? null,
      actorEmail: req.user!.email,
      action: "phones.smsSender.clear",
      targetType: "setting",
      ip: req.ip,
    });
    res.json({ smsSender: null });
  }),
);

router.post(
  "/test-sms",
  requirePermission("phone_numbers", "edit"),
  asyncHandler(async (req, res) => {
    const { to } = z.object({ to: z.string() }).parse(req.body);
    const result = await sendTestSms(to);
    void audit({
      actorId: req.user!.sub,
      actorBrandId: req.user!.brandId ?? null,
      actorEmail: req.user!.email,
      action: "phones.smsSender.test",
      targetType: "setting",
      metadata: result,
      ip: req.ip,
    });
    res.json({ ok: true, ...result });
  }),
);

/* --------------------------- Auto-replenish --------------------------- */
router.get(
  "/replenish-config",
  asyncHandler(async (_req, res) => {
    res.json(await getReplenishConfig());
  }),
);

router.put(
  "/replenish-config",
  requirePermission("phone_numbers", "edit"),
  asyncHandler(async (req, res) => {
    const body = z
      .object({
        target: z.number().int().min(0).max(100).optional(),
        autoPurchase: z.boolean().optional(),
        country: z.string().min(2).max(2).optional(),
        userPurchase: z.boolean().optional(),
        allowedCountries: z.array(z.string().length(2)).max(60).optional(),
        allowedPrefixes: z.record(z.array(z.string().max(4)).max(20)).optional(),
      })
      .parse(req.body);
    const config = await setReplenishConfig(body);
    void audit({
      actorId: req.user!.sub,
      actorBrandId: req.user!.brandId ?? null,
      actorEmail: req.user!.email,
      action: "phones.replenishConfig",
      targetType: "setting",
      metadata: config,
      ip: req.ip,
    });
    res.json(config);
  }),
);

router.post(
  "/replenish",
  requirePermission("phone_numbers", "create"),
  asyncHandler(async (req, res) => {
    const result = await replenishPool();
    void audit({
      actorId: req.user!.sub,
      actorBrandId: req.user!.brandId ?? null,
      actorEmail: req.user!.email,
      action: "phones.replenish",
      targetType: "phoneNumber",
      metadata: result,
      ip: req.ip,
    });
    res.json(result);
  }),
);

router.post(
  "/cleanup-orphaned",
  requirePermission("phone_numbers", "delete"),
  asyncHandler(async (req, res) => {
    const result = await cleanupOrphaned();
    void audit({
      actorId: req.user!.sub,
      actorBrandId: req.user!.brandId ?? null,
      actorEmail: req.user!.email,
      action: "phones.cleanupOrphaned",
      targetType: "phoneNumber",
      metadata: result,
      ip: req.ip,
    });
    res.json(result);
  }),
);

router.post(
  "/clear-sync",
  requirePermission("phone_numbers", "edit"),
  asyncHandler(async (req, res) => {
    const result = await clearSync();
    void audit({
      actorId: req.user!.sub,
      actorBrandId: req.user!.brandId ?? null,
      actorEmail: req.user!.email,
      action: "phones.clearSync",
      targetType: "phoneNumber",
      metadata: result,
      ip: req.ip,
    });
    res.json(result);
  }),
);

router.post(
  "/resync-twilio",
  requirePermission("phone_numbers", "edit"),
  asyncHandler(async (req, res) => {
    let result;
    try {
      result = await resyncTwilio();
    } catch (e) {
      // Rejected/typo'd creds look identical — surface the error, change nothing.
      throw new HttpError(502, `Twilio reconciliation failed: ${e instanceof Error ? e.message : "unknown error"}`);
    }
    void audit({
      actorId: req.user!.sub,
      actorBrandId: req.user!.brandId ?? null,
      actorEmail: req.user!.email,
      action: "phones.resyncTwilio",
      targetType: "phoneNumber",
      metadata: result,
      ip: req.ip,
    });
    res.json(result);
  }),
);

export default router;
