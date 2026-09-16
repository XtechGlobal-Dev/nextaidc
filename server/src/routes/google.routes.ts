import express from "express";
import { z } from "zod";
import { asyncHandler, notImplemented } from "../lib/http.js";
import { requireAuth } from "../middleware/auth.js";
import { signState, verifyState } from "../lib/jwt.js";
import { requestTenant, tenantForUser } from "../services/tenantDb.js";
import { brandIdForOwner } from "../services/customerDirectory.js";
import { appBaseUrl, corsOrigins } from "../env.js";
import { brandAppOrigin, brandReturnOrigins, isAllowedReturnOrigin } from "../lib/brandUrls.js";
import { cachedBrand } from "../services/brands.js";
import {
  isGoogleConfigured,
  buildAuthUrl,
  exchangeCode,
  fetchGoogleEmail,
  saveTokens,
  getTokens,
  clearTokens,
  createCalendarEvent,
  deleteCalendarEvent,
} from "../services/google.js";

const router = express.Router();

router.get(
  "/auth-url",
  requireAuth,
  asyncHandler(async (req, res) => {
    if (!isGoogleConfigured()) {
      throw notImplemented("Google is not configured (add Google OAuth keys in Admin → Settings)");
    }
    // Google only calls our one registered callback, so the brand's origin travels in
    // the signed state — otherwise brand users land on the platform domain with no session.
    const url = buildAuthUrl(signState(req.user!.sub, brandAppOrigin(req.user!.brandId ?? null)));
    res.json({ url });
  }),
);

// Public OAuth callback shared by every brand. The return origin from the state is
// re-validated against the brand's current hosts (not just the signature) — a domain
// can be un-verified in the ten minutes the state lives, and trusting it = open redirect.
router.get(
  "/callback",
  asyncHandler(async (req, res) => {
    // Last-resort destination when the state is unreadable and we have no idea
    // which brand this was: the platform's own app.
    const fallback = appBaseUrl || corsOrigins[0];
    let target = fallback;
    try {
      const code = String(req.query.code || "");
      const state = String(req.query.state || "");
      if (!code || !state) throw new Error("missing code/state");

      const { userId, returnOrigin } = verifyState(state);

      const userBrandId = await brandIdForOwner(userId);
      const brand = cachedBrand(userBrandId);
      const allowed = [...brandReturnOrigins(brand), appBaseUrl, ...corsOrigins];
      target =
        returnOrigin && isAllowedReturnOrigin(returnOrigin, allowed)
          ? returnOrigin
          : brandAppOrigin(userBrandId);

      const tokens = await exchangeCode(code);
      const email = await fetchGoogleEmail(tokens.access_token);

      await saveTokens(userId, {
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token,
        email,
      });
      // The CRM row is in the customer's brand's database; this is Google's
      // redirect, so the owner comes from the state, not a session.
      await (await tenantForUser(userId)).crmIntegration.upsert({
        where: { userId },
        update: { googleCalendarConnected: true },
        create: { userId, googleCalendarConnected: true },
      });

      // Booking (Google Calendar) is connected from the Booking module now, so
      // return the user there rather than Account Settings.
      res.redirect(`${target}/dashboard/booking?google=connected`);
    } catch {
      res.redirect(`${target}/dashboard/booking?google=error`);
    }
  }),
);

router.get(
  "/status",
  requireAuth,
  asyncHandler(async (req, res) => {
    const userId = req.user!.sub;
    const crm = await (await requestTenant(req)).crmIntegration.findUnique({ where: { userId } });
    const tokens = await getTokens(userId);
    res.json({ connected: !!crm?.googleCalendarConnected, email: tokens?.email || undefined });
  }),
);

router.post(
  "/disconnect",
  requireAuth,
  asyncHandler(async (req, res) => {
    const userId = req.user!.sub;
    await clearTokens(userId);
    await (await requestTenant(req)).crmIntegration.upsert({
      where: { userId },
      update: { googleCalendarConnected: false },
      create: { userId, googleCalendarConnected: false },
    });
    res.json({ ok: true });
  }),
);

const eventSchema = z.object({
  summary: z.string().min(1),
  description: z.string().optional(),
  startISO: z.string().min(1),
  endISO: z.string().min(1),
});

router.post(
  "/events",
  requireAuth,
  asyncHandler(async (req, res) => {
    const evt = eventSchema.parse(req.body);
    const result = await createCalendarEvent(req.user!.sub, evt);
    res.json(result);
  }),
);

// Self-test: create then delete a short event, proving the token can both write and delete.
router.post(
  "/test",
  requireAuth,
  asyncHandler(async (req, res) => {
    const userId = req.user!.sub;
    const start = new Date(Date.now() + 5 * 60_000);
    const end = new Date(start.getTime() + 15 * 60_000);
    const created = await createCalendarEvent(userId, {
      summary: "Booking connection test (safe to ignore)",
      description: "Automatic test from your AI receptionist — this event is removed instantly.",
      startISO: start.toISOString(),
      endISO: end.toISOString(),
    });
    if (!created.ok) {
      res.json({
        ok: false,
        message: created.error
          ? `Calendar test failed: ${created.error}`
          : "Couldn't create a test event on your calendar.",
      });
      return;
    }
    if (created.id) await deleteCalendarEvent(userId, created.id);
    res.json({ ok: true, message: "Google Calendar is working — test event created and removed." });
  }),
);

export default router;
