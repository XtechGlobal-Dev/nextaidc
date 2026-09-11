import express from "express";
import { z } from "zod";
import { prisma } from "../prisma.js";
import { asyncHandler } from "../lib/http.js";
import { env } from "../env.js";
import { sendEmail } from "../services/email.js";
import { integrationsStatus } from "../services/settings.js";
import { escapeHtml } from "../lib/escapeHtml.js";
import { rateLimit } from "../middleware/rateLimit.js";

const router = express.Router();

const bookingSchema = z.object({
  topic: z.string().min(1),
  name: z.string().min(1),
  email: z.string().email(),
  phone: z.string().optional().default(""),
  preferredAt: z.string().optional().default(""),
  message: z.string().optional().default(""),
});

/** POST /api/bookings — capture a demo/strategy/meeting booking (public). */
router.post(
  "/",
  rateLimit({ windowMs: 60_000, max: 20 }),
  asyncHandler(async (req, res) => {
    const data = bookingSchema.parse(req.body);
    const booking = await prisma.booking.create({ data });

    // Notify the owner by email if SMTP is configured (best-effort).
    if (integrationsStatus().email) {
      try {
        await sendEmail({
          to: env.SMTP_FROM,
          subject: `New ${data.topic} booking from ${data.name}`,
          html: `<h2>New ${escapeHtml(data.topic)}</h2>
            <p><b>Name:</b> ${escapeHtml(data.name)}</p>
            <p><b>Email:</b> ${escapeHtml(data.email)}</p>
            <p><b>Phone:</b> ${escapeHtml(data.phone) || "—"}</p>
            <p><b>Preferred:</b> ${escapeHtml(data.preferredAt) || "—"}</p>
            <p><b>Message:</b> ${escapeHtml(data.message) || "—"}</p>`,
        });
      } catch {
        /* email failure must not fail the booking */
      }
    }

    res.status(201).json({ ok: true, id: booking.id });
  }),
);

export default router;
