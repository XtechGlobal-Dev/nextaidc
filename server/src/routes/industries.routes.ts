import express from "express";
import { asyncHandler, badRequest } from "../lib/http.js";
import { requireAuth } from "../middleware/auth.js";
import { sanitizeIndustry } from "../lib/industries.js";
import { getPublicIndustries, suggestIndustry } from "../services/settings.js";
import { publishToAdmins } from "../services/events.js";

const router = express.Router();

/** The industry options for the AI Brain picker: built-ins + admin-approved
 *  customs. Authenticated (used inside the dashboard) but not admin-gated. */
router.get(
  "/",
  requireAuth,
  asyncHandler(async (_req, res) => {
    res.json({ industries: getPublicIndustries() });
  }),
);

/** A customer proposes a custom industry when none in the list fits. It's usable
 *  on their own profile immediately (the client sets it); this only queues it for
 *  admin review so it can later join the shared list. Re-validated server-side. */
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
    res.json({ status: outcome, value: result.value });
  }),
);

export default router;
