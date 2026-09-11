/**
 * Human Call Transfer API (tenant-side).
 *
 *   GET    /api/transfer                → the owner's transfer settings
 *   PATCH  /api/transfer                → update enable / number / timeout / message
 *   GET    /api/transfer/departments    → list departments
 *   POST   /api/transfer/departments    → add a department
 *   PATCH  /api/transfer/departments/:id → update a department
 *   DELETE /api/transfer/departments/:id → remove a department
 */
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

/**
 * Departments this owner's plan allows right now — 0 when it excludes transfer.
 *
 * Enforced on every WRITE rather than once at the top of the router: reads stay
 * open so a downgraded owner can still see (and delete) what they configured,
 * which is exactly what the downgrade flow asks them to do.
 */
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
    // This path used to be capped only by the schema's global max(20), so it was
    // the way around the per-request count check the POST does. It has to carry
    // the same plan limit or "Save Changes" quietly grants unlimited departments.
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
