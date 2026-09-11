import express from "express";
import { z } from "zod";
import { requestTenant, tenantForUser } from "../services/tenantDb.js";
import { asyncHandler } from "../lib/http.js";
import { requireAuth, requireCustomerAccount } from "../middleware/auth.js";
import type { AgentConfig } from "../lib/agentConfig.js";
import { upsertAssistant, getBookingToolConfig } from "../services/vapi.js";
import { markVapiSyncPending, markVapiSynced } from "../services/vapiSync.js";
import { getBookingConfig } from "../services/booking/config.js";
import {
  defaultWorkingHours,
  serializeWorkingHours,
  type WorkingHours,
} from "../services/booking/hours.js";
import {
  bookAppointment,
  cancelAppointment,
  rescheduleAppointment,
} from "../services/booking/engine.js";

/* ------------------------------------------------------------------ *
 *  Owner-facing booking module API (authed). Powers the 3-tab Booking UI:
 *  Overview, Calendar, Settings. All config lives on the existing CrmIntegration
 *  row (+ Profile.website) — no new config surface.
 * ------------------------------------------------------------------ */

const router = express.Router();

/** Re-push the owner's live assistant so booking tool/prompt changes take effect
 *  on real inbound calls immediately (attaches/removes checkAvailability +
 *  createBooking as auto-book flips, and refreshes the booking prompt). Returns
 *  whether the live assistant was actually updated. Never throws.
 *
 *  Strictly a re-sync: it never brings an assistant into existence. Gating on the
 *  conversion row alone wasn't enough — that row is created at signup for every
 *  account, so a customer with no plan and no number who merely saved their
 *  booking settings reached upsertAssistant with a null id and had a live Vapi
 *  assistant CREATED for them, bypassing the provisioning rules in
 *  provisionAgentForUser. Provisioning stays owned by picking a plan or claiming
 *  a number; the config saved here is picked up whenever that happens. */
async function resyncAssistant(userId: string): Promise<boolean> {
  // Read outside the try so the catch can queue a retry against this row.
  const db = await tenantForUser(userId).catch(() => null);
  if (!db) return false;
  const conv = await db.conversion.findUnique({ where: { userId } }).catch(() => null);
  if (!conv?.vapiAssistantId) return false; // no live assistant yet — nothing to sync
  try {
    const id = await upsertAssistant(
      conv.agentConfig as unknown as AgentConfig,
      conv.vapiAssistantId,
      { ownerId: userId },
    );
    if (id && id !== conv.vapiAssistantId) {
      await db.conversion.update({ where: { id: conv.id }, data: { vapiAssistantId: id } });
    }
    await markVapiSynced(db, conv.id);
    return true;
  } catch (e) {
    console.warn(`[booking] assistant resync failed for ${userId}:`, e);
    // Queue it: the settings are already saved, so without a retry the AI would
    // keep taking (or refusing) bookings on the old rules with no sign anything
    // is wrong.
    await markVapiSyncPending(db, conv.id, e);
    return false;
  }
}

/** Serialize an Appointment row for the client. */
function toDto(a: {
  id: string;
  customerName: string;
  customerPhone: string;
  customerEmail: string;
  notes: string;
  startAt: Date;
  endAt: Date;
  timezone: string;
  status: string;
  source: string;
  googleEventId: string;
  createdAt: Date;
}) {
  return {
    id: a.id,
    customerName: a.customerName,
    customerPhone: a.customerPhone,
    customerEmail: a.customerEmail,
    notes: a.notes,
    startAt: a.startAt.toISOString(),
    endAt: a.endAt.toISOString(),
    timezone: a.timezone,
    status: a.status,
    source: a.source,
    hasEvent: !!a.googleEventId,
    createdAt: a.createdAt.toISOString(),
  };
}

/* ---- Tool config (for the frontend test call) ---- */
router.get(
  "/tool-config",
  requireAuth,
  requireCustomerAccount,
  asyncHandler(async (req, res) => {
    const cfg = await getBookingToolConfig(req.user!.sub);
    res.json({ enabled: cfg.enabled, tools: cfg.tools, promptSection: cfg.promptSection });
  }),
);

/* ---- Overview dashboard ---- */
router.get(
  "/overview",
  requireAuth,
  requireCustomerAccount,
  asyncHandler(async (req, res) => {
    const userId = req.user!.sub;
    const config = await getBookingConfig(userId);
    const now = new Date();
    const startOfDay = new Date(now);
    startOfDay.setHours(0, 0, 0, 0);
    const endOfDay = new Date(startOfDay.getTime() + 24 * 60 * 60 * 1000);

    const db = await requestTenant(req);
    const [upcoming, todayCount] = await Promise.all([
      db.appointment.findMany({
        where: { userId, status: "confirmed", startAt: { gte: now } },
        orderBy: { startAt: "asc" },
        take: 10,
      }),
      db.appointment.count({
        where: { userId, status: "confirmed", startAt: { gte: startOfDay, lt: endOfDay } },
      }),
    ]);

    res.json({
      connected: config.connected,
      autoBookEnabled: config.autoBookEnabled,
      canAutoBook: config.canAutoBook,
      timezone: config.timezone,
      todayCount,
      upcoming: upcoming.map(toDto),
    });
  }),
);

/* ---- Appointments list (Calendar tab) ---- */
router.get(
  "/appointments",
  requireAuth,
  requireCustomerAccount,
  asyncHandler(async (req, res) => {
    const userId = req.user!.sub;
    const from = typeof req.query.from === "string" ? new Date(req.query.from) : null;
    const to = typeof req.query.to === "string" ? new Date(req.query.to) : null;
    const status = typeof req.query.status === "string" ? req.query.status : "";

    const where: Record<string, unknown> = { userId };
    if (status === "confirmed" || status === "cancelled") where.status = status;
    const startAt: Record<string, Date> = {};
    if (from && !Number.isNaN(from.getTime())) startAt.gte = from;
    if (to && !Number.isNaN(to.getTime())) startAt.lte = to;
    if (Object.keys(startAt).length) where.startAt = startAt;

    const appts = await (await requestTenant(req)).appointment.findMany({
      where,
      orderBy: { startAt: "asc" },
      take: 500,
    });
    res.json({ appointments: appts.map(toDto) });
  }),
);

const createSchema = z.object({
  customerName: z.string().optional().default(""),
  customerPhone: z.string().optional().default(""),
  customerEmail: z.string().optional().default(""),
  notes: z.string().optional().default(""),
  /** ISO start datetime (with offset). */
  startAt: z.string().min(1),
  /** Optional explicit end; else start + slot length. */
  endAt: z.string().optional(),
});

/* ---- Manual booking (owner adds one) ---- */
router.post(
  "/appointments",
  requireAuth,
  requireCustomerAccount,
  asyncHandler(async (req, res) => {
    const userId = req.user!.sub;
    const body = createSchema.parse(req.body);
    const config = await getBookingConfig(userId);
    const start = new Date(body.startAt);
    if (Number.isNaN(start.getTime())) {
      res.status(400).json({ error: "Invalid start time" });
      return;
    }
    const end =
      body.endAt && !Number.isNaN(new Date(body.endAt).getTime())
        ? new Date(body.endAt)
        : new Date(start.getTime() + config.durationMin * 60_000);

    const appt = await bookAppointment(userId, config, {
      startISO: start.toISOString(),
      endISO: end.toISOString(),
      name: body.customerName,
      phone: body.customerPhone,
      email: body.customerEmail,
      notes: body.notes,
      source: "manual",
    });
    res.status(201).json(toDto(appt));
  }),
);

/* ---- Cancel ---- */
router.post(
  "/appointments/:id/cancel",
  requireAuth,
  requireCustomerAccount,
  asyncHandler(async (req, res) => {
    const userId = req.user!.sub;
    const config = await getBookingConfig(userId);
    const updated = await cancelAppointment(userId, req.params.id, config.calendarId);
    if (!updated) {
      res.status(404).json({ error: "Appointment not found" });
      return;
    }
    res.json(toDto(updated));
  }),
);

const rescheduleSchema = z.object({ startAt: z.string().min(1), endAt: z.string().optional() });

/* ---- Reschedule ---- */
router.post(
  "/appointments/:id/reschedule",
  requireAuth,
  requireCustomerAccount,
  asyncHandler(async (req, res) => {
    const userId = req.user!.sub;
    const body = rescheduleSchema.parse(req.body);
    const config = await getBookingConfig(userId);
    const start = new Date(body.startAt);
    if (Number.isNaN(start.getTime())) {
      res.status(400).json({ error: "Invalid start time" });
      return;
    }
    const end =
      body.endAt && !Number.isNaN(new Date(body.endAt).getTime())
        ? new Date(body.endAt)
        : new Date(start.getTime() + config.durationMin * 60_000);
    const moved = await rescheduleAppointment(userId, config, req.params.id, start.toISOString(), end.toISOString());
    if (!moved) {
      res.status(404).json({ error: "Appointment not found" });
      return;
    }
    res.json(toDto(moved));
  }),
);

/* ---- Settings ---- */
router.get(
  "/settings",
  requireAuth,
  requireCustomerAccount,
  asyncHandler(async (req, res) => {
    const userId = req.user!.sub;
    const config = await getBookingConfig(userId);
    res.json({
      connected: config.connected,
      autoBookEnabled: config.autoBookEnabled,
      durationMin: config.durationMin,
      calendarId: config.calendarId,
      timezone: config.timezone,
      hours: config.hours,
    });
  }),
);

const dayHoursSchema = z.object({
  open: z.boolean(),
  start: z.string().regex(/^([01]?\d|2[0-3]):[0-5]\d$/),
  end: z.string().regex(/^([01]?\d|2[0-3]):[0-5]\d$/),
});

const settingsSchema = z.object({
  autoBookEnabled: z.boolean().optional(),
  durationMin: z.number().int().min(5).max(480).optional(),
  calendarId: z.string().optional(),
  timezone: z.string().optional(),
  /** Per-weekday hours keyed "0".."6". */
  hours: z.record(z.string(), dayHoursSchema).optional(),
});

router.put(
  "/settings",
  requireAuth,
  requireCustomerAccount,
  asyncHandler(async (req, res) => {
    const userId = req.user!.sub;
    const body = settingsSchema.parse(req.body);

    const data: Record<string, unknown> = {};
    if (body.autoBookEnabled !== undefined) data.bookingEnabled = body.autoBookEnabled;
    if (body.durationMin !== undefined) data.bookingDurationMin = body.durationMin;
    if (body.calendarId !== undefined) data.bookingCalendarId = body.calendarId.trim() || "primary";
    if (body.timezone !== undefined) data.bookingTimezone = body.timezone.trim();
    if (body.hours !== undefined) {
      const merged: WorkingHours = defaultWorkingHours();
      for (let d = 0; d < 7; d++) {
        const day = body.hours[String(d)];
        if (day) merged[d] = day;
      }
      data.bookingHours = serializeWorkingHours(merged);
    }

    await (await requestTenant(req)).crmIntegration.upsert({
      where: { userId },
      update: data,
      create: { userId, ...data },
    });

    // Booking behaviour changed → re-push the live assistant NOW (awaited) so the
    // tools + prompt on real inbound calls immediately match the new settings, and
    // the response can tell the user whether their AI was updated.
    const synced = await resyncAssistant(userId);

    const config = await getBookingConfig(userId);
    res.json({
      connected: config.connected,
      autoBookEnabled: config.autoBookEnabled,
      durationMin: config.durationMin,
      calendarId: config.calendarId,
      timezone: config.timezone,
      hours: config.hours,
      synced,
    });
  }),
);

export default router;
