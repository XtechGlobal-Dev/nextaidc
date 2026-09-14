// Human Call Transfer API (tenant-side): the owner's transfer settings and departments.
import express from "express";
import { asyncHandler, HttpError } from "../lib/http.js";
import { requireAuth, requireCustomerAccount } from "../middleware/auth.js";
import {
  settingsPatchSchema,
  departmentInputSchema,
  departmentPatchSchema,
  departmentsReplaceSchema,
} from "../lib/transfer.js";
import {
  getOrCreateSettings,
  updateSettings,
  listDepartments,
  createDepartment,
  updateDepartment,
  deleteDepartment,
  replaceDepartments,
} from "../services/transfer.js";
import { getPlanFeatures } from "../services/trial.js";
import { requestTenant } from "../services/tenantDb.js";

const router = express.Router();

router.use(requireAuth, requireCustomerAccount);

// Plan's department allowance (0 = no transfer). Enforced on writes only, so a
// downgraded owner can still see and delete what they configured.
async function allowance(userId: string): Promise<number> {
  return (await getPlanFeatures(userId)).callTransferDepartments;
}

/** Refuse any write when the plan has no transfer at all. */
async function assertTransferIncluded(userId: string): Promise<number> {
  const max = await allowance(userId);
  if (max === 0) {
    throw new HttpError(403, "Your plan doesn't include Call Transfer. Upgrade to unlock it.");
  }
  return max;
}

router.get(
  "/",
  asyncHandler(async (req, res) => {
    res.json(await getOrCreateSettings(req.user!.sub));
  }),
);

router.patch(
  "/",
  asyncHandler(async (req, res) => {
    const data = settingsPatchSchema.parse(req.body);
    await assertTransferIncluded(req.user!.sub);
    res.json(await updateSettings(req.user!.sub, data));
  }),
);

router.get(
  "/departments",
  asyncHandler(async (req, res) => {
    res.json(await listDepartments(req.user!.sub));
  }),
);

// Replace the whole list in one atomic save (the single "Save Changes" button).
router.put(
  "/departments",
  asyncHandler(async (req, res) => {
    const { departments } = departmentsReplaceSchema.parse(req.body);
    // Must carry the same plan limit as POST — capped only by the schema's max(20),
    // "Save Changes" quietly granted unlimited departments.
    const max = await assertTransferIncluded(req.user!.sub);
    if (departments.length > max) {
      throw new HttpError(400, `Your plan allows up to ${max} department${max === 1 ? "" : "s"}.`);
    }
    res.json(await replaceDepartments(req.user!.sub, departments));
  }),
);

router.post(
  "/departments",
  asyncHandler(async (req, res) => {
    const data = departmentInputSchema.parse(req.body);
    const max = await assertTransferIncluded(req.user!.sub);
    const count = await (await requestTenant(req)).transferDepartment.count({
      where: { userId: req.user!.sub },
    });
    if (count >= max) {
      throw new HttpError(
        400,
        `Your plan allows up to ${max} department${max === 1 ? "" : "s"}. Upgrade to add more.`,
      );
    }
    res.status(201).json(await createDepartment(req.user!.sub, data));
  }),
);

router.patch(
  "/departments/:id",
  asyncHandler(async (req, res) => {
    const data = departmentPatchSchema.parse(req.body);
    await assertTransferIncluded(req.user!.sub);
    const updated = await updateDepartment(req.user!.sub, req.params.id, data);
    if (!updated) throw new HttpError(404, "Department not found");
    res.json(updated);
  }),
);

router.delete(
  "/departments/:id",
  asyncHandler(async (req, res) => {
    const ok = await deleteDepartment(req.user!.sub, req.params.id);
    if (!ok) throw new HttpError(404, "Department not found");
    res.json({ ok: true });
  }),
);

export default router;
