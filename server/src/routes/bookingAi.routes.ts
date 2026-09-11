import express from "express";
import { asyncHandler } from "../lib/http.js";
import { getBookingConfig } from "../services/booking/config.js";
import { computeAvailability } from "../services/booking/availability.js";
import {
  bookAppointment,
  cancelByPhone,
  findUpcomingByPhone,
  rescheduleAppointment,
  resolveSlotInstant,
} from "../services/booking/engine.js";
import { formatLocal } from "../services/booking/hours.js";
import { isTwilioConfigured } from "../services/sms.js";
import { parseToolCalls, toolArgString as str } from "../lib/vapiToolCalls.js";

/* ------------------------------------------------------------------ *
 *  Vapi booking tool dispatcher (PUBLIC — Vapi posts here mid-call, no auth).
 *  The owning business is resolved from `?uid=<userId>` stamped on the tool URL
 *  (web test calls run a transient assistant with no persisted id, so the id has
 *  to travel on the URL). Every tool responds with a short spoken string.
 * ------------------------------------------------------------------ */

const router = express.Router();

/** Spoken fallback when a booking tool fires but auto-booking isn't available
 *  (e.g. a stale assistant whose settings changed). Takes a message — there is
 *  no online-booking path any more. */
function noAutoBookReply(what: string): string {
  return `I can't ${what}, but I can take your details and the team will get you booked in.`;
}

/** Run one booking tool and return the spoken result string. */
async function runTool(
  uid: string,
  callerNumber: string,
  name: string,
  args: Record<string, unknown>,
): Promise<string> {
  const config = await getBookingConfig(uid);
  const phone = str(args.phone) || callerNumber;

  switch (name) {
    case "checkAvailability": {
      // Defensive: the tool is only attached when canAutoBook is true, but a
      // stale assistant (a settings save whose Vapi push failed) can still call it.
      if (!config.canAutoBook) return noAutoBookReply("check the calendar directly");
      const date = str(args.date);
      if (!date) return "What date would you like to come in?";
      const slots = await computeAvailability({
        userId: uid,
        dateISO: date,
        hours: config.hours,
        durationMin: config.durationMin,
        timezone: config.timezone,
        calendarId: config.calendarId,
        useGoogle: config.connected,
      });
      if (!slots.length) return `Sorry, there's nothing open on ${date}. Would another day work?`;
      const times = slots.slice(0, 8).map((s) => s.label).join(", ");
      return `On ${date} these times are open: ${times}. Which would you like?`;
    }

    case "createBooking": {
      if (!config.canAutoBook) return noAutoBookReply("book that directly");
      const date = str(args.date);
      const time = str(args.time);
      if (!date || !time) return "Which date and time would you like to book?";
      const resolved = resolveSlotInstant(config, date, time);
      if (!resolved) return `Sorry, ${time} isn't one of our slots on ${date}. Would you like me to list the open times?`;
      // Re-check availability so we never book over busy time.
      const open = await computeAvailability({
        userId: uid,
        dateISO: date,
        hours: config.hours,
        durationMin: config.durationMin,
        timezone: config.timezone,
        calendarId: config.calendarId,
        useGoogle: config.connected,
      });
      if (!open.some((s) => s.startISO === resolved.startISO)) {
        return `Sorry, ${time} on ${date} is no longer available. Would you like another time?`;
      }
      await bookAppointment(uid, config, {
        startISO: resolved.startISO,
        endISO: resolved.endISO,
        name: str(args.name),
        phone,
        email: str(args.email),
        notes: str(args.notes),
        source: "ai",
      });
      // Only promise a text when SMS can actually send (Twilio configured + a
      // number to send to) — otherwise the booking is still made, just no SMS.
      const willText = !!phone && isTwilioConfigured();
      return `You're booked for ${formatLocal(resolved.startISO, config.timezone)}. ${
        willText ? "I've sent a confirmation text. " : ""
      }The team will connect with you shortly.`;
    }

    case "cancelBooking": {
      if (!config.canAutoBook) return "I'm not able to cancel bookings on this call.";
      const cancelled = await cancelByPhone(uid, phone, config.calendarId);
      return cancelled
        ? `Done — I've cancelled your appointment on ${formatLocal(cancelled.startAt.toISOString(), config.timezone)}.`
        : "I couldn't find an upcoming appointment under that number. Could you confirm the number you booked with?";
    }

    case "rescheduleBooking": {
      if (!config.canAutoBook) return "I'm not able to reschedule bookings on this call.";
      const date = str(args.date);
      const time = str(args.time);
      if (!date || !time) return "What new date and time would you like?";
      const existing = await findUpcomingByPhone(uid, phone);
      if (!existing) return "I couldn't find an upcoming appointment under that number.";
      const resolved = resolveSlotInstant(config, date, time);
      if (!resolved) return `Sorry, ${time} isn't one of our slots on ${date}.`;
      const open = await computeAvailability({
        userId: uid,
        dateISO: date,
        hours: config.hours,
        durationMin: config.durationMin,
        timezone: config.timezone,
        calendarId: config.calendarId,
        useGoogle: config.connected,
      });
      if (!open.some((s) => s.startISO === resolved.startISO)) {
        return `Sorry, ${time} on ${date} isn't available. Would you like another time?`;
      }
      const moved = await rescheduleAppointment(uid, config, existing.id, resolved.startISO, resolved.endISO);
      return moved
        ? `All set — I've moved your appointment to ${formatLocal(resolved.startISO, config.timezone)}.`
        : "Sorry, I couldn't reschedule that just now.";
    }

    default:
      return "Sorry, I couldn't do that.";
  }
}

// Vapi posts every booking tool call here. We resolve the business from ?uid and
// reply with { results: [{ toolCallId, result }] } — the string is spoken back.
router.post(
  "/",
  asyncHandler(async (req, res) => {
    const uid = String(req.query.uid || "").trim();
    const { calls, callerNumber } = parseToolCalls(req.body);
    if (!uid || !calls.length) {
      res.json({ results: [] });
      return;
    }
    const results = [];
    for (const c of calls) {
      let result: string;
      try {
        result = await runTool(uid, callerNumber, c.name, c.args);
      } catch (e) {
        console.error(`[booking] tool ${c.name} failed for uid ${uid}:`, e);
        result = "Sorry, something went wrong on my end.";
      }
      results.push({ toolCallId: c.id, result });
    }
    res.json({ results });
  }),
);

export default router;
