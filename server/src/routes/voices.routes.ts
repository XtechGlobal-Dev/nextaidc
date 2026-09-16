import express from "express";
import { asyncHandler } from "../lib/http.js";
import { requireAuth } from "../middleware/auth.js";
import { requestTenant } from "../services/tenantDb.js";
import {
  getVoiceCatalogFor,
  getUserVoiceAccess,
  resolveVoices,
  DEFAULT_AGENT_VOICE_ID,
} from "../services/voices.js";
import { sendValidated } from "../lib/respond.js";
import { AllVoicesResponseSchema, VoiceCatalogResponseSchema } from "../../../shared/contracts/voices.js";

const router = express.Router();

/** Both providers' full catalogs for the admin Voice Bank + plan editor. */
router.get(
  "/all",
  requireAuth,
  asyncHandler(async (_req, res) => {
    const [deepgram, elevenlabs] = await Promise.all([
      getVoiceCatalogFor("deepgram"),
      getVoiceCatalogFor("elevenlabs"),
    ]);
    sendValidated(res, AllVoicesResponseSchema, { deepgram, elevenlabs });
  }),
);

// Voices this user may pick, from their plan's Voice Bank category (admins get all).
// `locked` = no plan/category yet, so they stay on the default.
router.get(
  "/",
  requireAuth,
  asyncHandler(async (req, res) => {
    // The platform's own people have no agent; a brand account's is in its brand.
    const conversion = req.user!.brandId
      ? await (await requestTenant(req)).conversion.findUnique({
          where: { userId: req.user!.sub },
          select: { agentConfig: true },
        })
      : null;
    const currentVoiceId =
      (conversion?.agentConfig as { identity?: { voiceId?: string } })?.identity?.voiceId ||
      DEFAULT_AGENT_VOICE_ID;

    const [access, current] = await Promise.all([
      getUserVoiceAccess(req.user!.sub),
      resolveVoices([currentVoiceId]),
    ]);
    const voices = await resolveVoices(access.voiceIds);
    sendValidated(res, VoiceCatalogResponseSchema, {
      voices: voices.map((v) => ({ ...v, entitled: true, plans: [] })),
      // The voice the agent is currently on (always resolvable, even when locked) so
      // the UI can label it without the selectable list.
      current: current[0] ? { ...current[0], entitled: true, plans: [] } : null,
      locked: !access.canChange,
      category: access.categoryTitle,
      currentPlanName: access.planName,
    });
  }),
);

export default router;
