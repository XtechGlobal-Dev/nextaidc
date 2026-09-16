import type { NextFunction, Request, Response } from "express";
import { unauthorized } from "../lib/http.js";
import { getEntitlement, entitlementError, reconcileSubscription } from "../services/trial.js";
import { isAdminRole } from "../lib/roles.js";

/** Gate paid features behind an active entitlement (trial or plan with minutes). Mount AFTER requireAuth.
 *  Blocked → 403 `{ success, code, message }` so the frontend can show the right prompt. */
export async function validateTrial(req: Request, res: Response, next: NextFunction) {
  if (!req.user) return next(unauthorized());

  // Admins manage the platform and aren't subject to customer trial/plan limits
  // (so they can test calls, the assistant, etc. without a subscription).
  if (isAdminRole(req.user.role)) return next();

  try {
    // Auto-activate the paid plan if the trial just ended (charges the saved
    // card) before deciding whether to block.
    await reconcileSubscription(req.user.sub);
    const state = await getEntitlement(req.user.sub);
    if (!state.blocked) return next();

    const { code, message } = entitlementError(state);
    res.status(403).json({ success: false, code, message });
  } catch (err) {
    next(err);
  }
}
