import express from "express";
import { asyncHandler, badRequest } from "../lib/http.js";
import { requireAuth } from "../middleware/auth.js";
import { sanitizeIndustry } from "../lib/industries.js";
import { getPublicIndustries, suggestIndustry } from "../services/settings.js";
import { publishToAdmins } from "../services/events.js";
import { sendValidated } from "../lib/respond.js";
import {
  IndustriesListResponseSchema,
  IndustrySuggestResponseSchema,
} from "../../../shared/contracts/industries.js";

const router = express.Router();

/** The industry options for the AI Brain picker: built-ins + admin-approved
 *  customs. Authenticated (used inside the dashboard) but not admin-gated. */
router.get(
  "/",
  requireAuth,
  asyncHandler(async (_req, res) => {
    sendValidated(res, IndustriesListResponseSchema, { industries: getPublicIndustries() });
  }),
);

/** Propose a custom industry. Usable on the customer's own profile right away; this only queues it for admin review. */
router.post(
  "/suggest",
  requireAuth,
  asyncHandler(async (req, res) => {
    const result = sanitizeIndustry((req.body as { value?: unknown })?.value);
    if ("error" in result) throw badRequest(result.error);
    const outcome = await suggestIndustry(result.value, {
      id: req.user!.sub,
      email: req.user!.email,
    });
    // A genuinely new proposal → nudge admin tabs so the review queue updates
    // live (via useLiveData → useLiveTick) instead of only on a page reload.
    if (outcome === "submitted") publishToAdmins({ type: "industry.suggested" });
    sendValidated(res, IndustrySuggestResponseSchema, { status: outcome, value: result.value });
  }),
);

export default router;
