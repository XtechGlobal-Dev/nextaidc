import express from "express";
import { z } from "zod";
import { asyncHandler } from "../lib/http.js";
import { requireAuth } from "../middleware/auth.js";
import { planeOf, tenantFor } from "../services/tenantDb.js";
import {
  listNotifications,
  markNotificationRead,
  markAllNotificationsRead,
  clearNotifications,
} from "../services/notifications.js";
import { integrationsStatus } from "../services/settings.js";
import { getPlanFeatures, getEntitlement, entitlementError } from "../services/trial.js";
import { callSummaryEmail } from "../services/email.js";
import { isTwilioConfigured, callSummarySms, describeSmsError } from "../services/sms.js";
import { isWhatsAppConfigured, callSummaryWhatsApp } from "../services/whatsapp.js";
import { isAdminRole } from "../lib/roles.js";
import { brandDisplayName } from "../lib/brandUrls.js";
import { sendValidated } from "../lib/respond.js";
import { OkResponseSchema } from "hello22/shared/contracts/common.js";
import {
  NotificationChannelsResponseSchema,
  NotificationsListResponseSchema,
  TestSummaryResponseSchema,
} from "hello22/shared/contracts/notifications.js";

const router = express.Router();

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const testSummaryText = () =>
  `This is a test call summary from ${brandDisplayName()}. If you received this, your notifications are set up correctly.`;
// Sample caller number so the test summary shows the same "from <number>" line a real call would.
const TEST_CALLER_NUMBER = "+1 555 0100";

const testSummarySchema = z.object({
  channel: z.enum(["email", "sms", "whatsapp"]),
  to: z.string().trim().min(1, "A destination is required."),
});

/** Which summary channels the plan includes. Email is always on; SMS/WhatsApp depend on the plan (admins get all). */
router.get(
  "/channels",
  requireAuth,
  asyncHandler(async (req, res) => {
    const features = await getPlanFeatures(req.user!.sub);
    sendValidated(res, NotificationChannelsResponseSchema, {
      email: true,
      sms: features.sms,
      smsToCaller: features.smsToCaller,
      whatsapp: features.whatsapp,
      customCrm: features.customCrm,
      multilingual: features.multilingual,
      // Department allowance; 0 means the plan excludes Call Transfer.
      callTransferDepartments: features.callTransferDepartments,
    });
  }),
);

/** Sends a dummy call summary to check a channel works. Any logged-in user, own destination only; never used for login/OTP. */
router.post(
  "/test-summary",
  requireAuth,
  asyncHandler(async (req, res) => {
    const parsed = testSummarySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid request." });
      return;
    }
    const { channel, to } = parsed.data;

    if (channel === "email" && !EMAIL_RE.test(to)) {
      res.status(400).json({ error: "Enter a valid email address." });
      return;
    }

    // This spends real Twilio/Meta money, so gate on entitlement, not plan features —
    // features stay open all trial, but a card-required signup with no card gets nothing.
    if (!isAdminRole(req.user!.role)) {
      const ent = await getEntitlement(req.user!.sub);
      if (ent.blocked) {
        const { code, message } = entitlementError(ent);
        res.status(403).json({ error: message, code });
        return;
      }
    }

    // Channel must be included in the user's plan (email always allowed).
    if (channel !== "email") {
      const features = await getPlanFeatures(req.user!.sub);
      if ((channel === "sms" && !features.sms) || (channel === "whatsapp" && !features.whatsapp)) {
        res.status(403).json({ error: `Your plan doesn't include ${channel.toUpperCase()} summaries.` });
        return;
      }
    }

    // A brand account's business name is in its brand's database; the
    // platform's own people have none.
    const businessName = req.user!.brandId
      ? (
          await (await tenantFor(req.user!.brandId)).profile.findUnique({
            where: { userId: req.user!.sub },
            select: { businessName: true },
          })
        )?.businessName || undefined
      : undefined;

    try {
      if (channel === "email") {
        if (!integrationsStatus().email) {
          res.status(400).json({ error: "Email sending isn't configured yet. Ask an admin to set it up." });
          return;
        }
        await callSummaryEmail({ ownerEmail: to, callerName: "Test Caller", callerNumber: TEST_CALLER_NUMBER, summary: testSummaryText() });
      } else if (channel === "sms") {
        if (!isTwilioConfigured()) {
          res.status(400).json({ error: "SMS sending isn't configured yet. Ask an admin to set it up." });
          return;
        }
        await callSummarySms({ to, callerName: "Test Caller", callerNumber: TEST_CALLER_NUMBER, summary: testSummaryText(), businessName });
      } else {
        if (!isWhatsAppConfigured()) {
          res.status(400).json({ error: "WhatsApp sending isn't configured yet. Ask an admin to set it up." });
          return;
        }
        await callSummaryWhatsApp({ to, callerName: "Test Caller", callerNumber: TEST_CALLER_NUMBER, summary: testSummaryText(), businessName });
      }
      sendValidated(res, TestSummaryResponseSchema, { ok: true, to });
    } catch (err) {
      console.error("[test-summary] failed:", err);
      const error =
        channel === "sms"
          ? describeSmsError(err)
          : "Couldn't send the test message. Check the sender configuration.";
      res.status(502).json({ error });
    }
  }),
);

router.get(
  "/",
  requireAuth,
  asyncHandler(async (req, res) => {
    // Notifications follow the person (phase 4): a brand's account reads its
    // own brand's database, the platform's own people the control plane.
    const userId = req.user!.sub;
    const db = await planeOf(req.user!.brandId);
    const [notifications, unreadCount] = await Promise.all([
      listNotifications(db, userId),
      db.notification.count({ where: { userId, read: false } }),
    ]);
    sendValidated(res, NotificationsListResponseSchema, { notifications, unreadCount });
  }),
);

router.post(
  "/:id/read",
  requireAuth,
  asyncHandler(async (req, res) => {
    await markNotificationRead(await planeOf(req.user!.brandId), req.user!.sub, req.params.id);
    sendValidated(res, OkResponseSchema, { ok: true });
  }),
);

router.post(
  "/read-all",
  requireAuth,
  asyncHandler(async (req, res) => {
    await markAllNotificationsRead(await planeOf(req.user!.brandId), req.user!.sub);
    sendValidated(res, OkResponseSchema, { ok: true });
  }),
);

router.delete(
  "/",
  requireAuth,
  asyncHandler(async (req, res) => {
    await clearNotifications(await planeOf(req.user!.brandId), req.user!.sub);
    sendValidated(res, OkResponseSchema, { ok: true });
  }),
);

export default router;
