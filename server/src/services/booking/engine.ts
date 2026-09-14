import type { Appointment } from "@prisma/tenant-client";
import { tenantForUser } from "../tenantDb.js";
import {
  createCalendarEvent,
  deleteCalendarEvent,
  patchCalendarEventTime,
} from "../google.js";
import { textBookingConfirmation } from "../sms.js";
import { formatLocal, generateSlots } from "./hours.js";
import type { BookingConfig } from "./config.js";

// Booking engine. The Appointment row is the source of truth; Google and SMS writes are fire-and-forget
// (Vapi times tools out quickly), so a Google/SMS hiccup never loses the booking.

/** Display name for an unnamed caller (never fabricate a name). */
export const UNNAMED = "Customer";

export interface BookInput {
  startISO: string;
  endISO: string;
  name?: string;
  phone?: string;
  email?: string;
  notes?: string;
  source?: "ai" | "manual";
}

// Lead with WHAT was booked, then who, so the calendar shows the real booking rather than a generic "Appointment".
function eventSummary(name: string, notes: string): string {
  const reason = notes.trim();
  const subject = reason ? reason.charAt(0).toUpperCase() + reason.slice(1) : "Appointment";
  return name.trim() ? `${subject} — ${name.trim()}` : subject;
}

function eventDescription(a: { name: string; phone: string; email: string; notes: string }): string {
  return [
    a.name && `Name: ${a.name}`,
    a.phone && `Phone: ${a.phone}`,
    a.email && `Email: ${a.email}`,
    a.notes && `Notes: ${a.notes}`,
    "Booked by your AI receptionist.",
  ]
    .filter(Boolean)
    .join("\n");
}

/** Persists the row immediately, then fires the Google event and confirmation SMS in the background. Never throws for those side effects. */
export async function bookAppointment(
  userId: string,
  config: BookingConfig,
  input: BookInput,
): Promise<Appointment> {
  const name = (input.name ?? "").trim();
  const phone = (input.phone ?? "").trim();
  const email = (input.email ?? "").trim();
  const notes = (input.notes ?? "").trim();

  // Appointments live in the owner's brand's database.
  const db = await tenantForUser(userId);
  const appt = await db.appointment.create({
    data: {
      userId,
      customerName: name,
      customerPhone: phone,
      customerEmail: email,
      notes,
      startAt: new Date(input.startISO),
      endAt: new Date(input.endISO),
      timezone: config.timezone,
      status: "confirmed",
      source: input.source ?? "ai",
    },
  });

  // Fire-and-forget the Google event so the tool replies fast. On success, stamp
  // the event id back on the row so cancel/reschedule can act on it.
  if (config.connected) {
    void createCalendarEvent(userId, {
      summary: eventSummary(name, notes),
      description: eventDescription({ name, phone, email, notes }),
      startISO: input.startISO,
      endISO: input.endISO,
      calendarId: config.calendarId,
      timeZone: config.timezone || undefined,
      // Only invite a real email — an empty/invalid one 400s the whole event.
      attendeeEmail: /.+@.+\..+/.test(email) ? email : undefined,
    })
      .then((r) => {
        if (r.ok && r.id) {
          return db.appointment
            .update({ where: { id: appt.id }, data: { googleEventId: r.id } })
            .catch(() => undefined);
        }
        return undefined;
      })
      .catch((e) => console.error(`[booking] calendar write failed for appt ${appt.id}:`, e));
  }

  // Fire-and-forget confirmation SMS to the caller — with what they booked + the
  // business name so the text reads professionally.
  if (phone) {
    void textBookingConfirmation(phone, formatLocal(input.startISO, config.timezone), {
      reason: notes,
      businessName: config.businessName,
    });
  }

  return appt;
}

/** Cancel one appointment by id (owner-initiated). Marks it cancelled and deletes
 *  the Google event (fire-and-forget). Returns the updated row or null if not found. */
export async function cancelAppointment(
  userId: string,
  id: string,
  calendarId = "primary",
): Promise<Appointment | null> {
  const db = await tenantForUser(userId);
  const appt = await db.appointment.findFirst({ where: { id, userId } });
  if (!appt) return null;
  const updated = await db.appointment.update({
    where: { id: appt.id },
    data: { status: "cancelled" },
  });
  if (appt.googleEventId) {
    void deleteCalendarEvent(userId, appt.googleEventId, calendarId);
  }
  return updated;
}

/** The caller's most recent upcoming confirmed appointment (matched by phone) —
 *  what the AI's cancel/reschedule tools operate on. Null when none. */
export async function findUpcomingByPhone(
  userId: string,
  phone: string,
): Promise<Appointment | null> {
  const digits = phone.replace(/\D/g, "");
  if (!digits) return null;
  const upcoming = await (await tenantForUser(userId)).appointment.findMany({
    where: { userId, status: "confirmed", startAt: { gt: new Date() } },
    orderBy: { startAt: "asc" },
  });
  // Match on the trailing digits so "+61 400 000 000" and "0400000000" reconcile.
  return (
    upcoming.find((a) => {
      const d = a.customerPhone.replace(/\D/g, "");
      return d && (d.endsWith(digits) || digits.endsWith(d));
    }) ?? null
  );
}

/** Cancel the caller's upcoming appointment (AI cancel tool). */
export async function cancelByPhone(
  userId: string,
  phone: string,
  calendarId = "primary",
): Promise<Appointment | null> {
  const appt = await findUpcomingByPhone(userId, phone);
  if (!appt) return null;
  return cancelAppointment(userId, appt.id, calendarId);
}

/** Move an appointment to a new time (owner or AI reschedule). Updates the row and
 *  patches the linked Google event (fire-and-forget). Returns the updated row. */
export async function rescheduleAppointment(
  userId: string,
  config: BookingConfig,
  id: string,
  startISO: string,
  endISO: string,
): Promise<Appointment | null> {
  const db = await tenantForUser(userId);
  const appt = await db.appointment.findFirst({ where: { id, userId } });
  if (!appt) return null;
  const updated = await db.appointment.update({
    where: { id: appt.id },
    data: { startAt: new Date(startISO), endAt: new Date(endISO), status: "confirmed" },
  });
  if (appt.googleEventId) {
    void patchCalendarEventTime(userId, appt.googleEventId, startISO, endISO, {
      calendarId: config.calendarId,
      timeZone: config.timezone || undefined,
    });
  }
  if (updated.customerPhone) {
    void textBookingConfirmation(updated.customerPhone, formatLocal(startISO, config.timezone), {
      reason: updated.notes,
      businessName: config.businessName,
    });
  }
  return updated;
}

/** Resolves a caller's date + time ("HH:mm", "3:00 PM", "3pm") to a generated slot, matched by instant rather than string since LLMs echo times in varying formats. */
export function resolveSlotInstant(
  config: BookingConfig,
  dateISO: string,
  time: string,
): { startISO: string; endISO: string } | null {
  const slots = generateSlots(dateISO, config.hours, config.durationMin, config.timezone);
  if (!slots.length) return null;

  const target = parseTimeToMinutes(time);
  if (target == null) return null;

  // Match the slot whose local start time equals the requested minutes-of-day.
  for (const s of slots) {
    const mins = localMinutesOfDay(s.startISO, config.timezone);
    if (mins === target) return { startISO: s.startISO, endISO: s.endISO };
  }
  return null;
}

/** Local minutes-since-midnight of a UTC instant in a timezone (via the label). */
function localMinutesOfDay(instantISO: string, tz: string): number {
  // formatLocal-style parse: re-derive "h:mm A" and convert.
  const label = formatLocal(instantISO, tz); // "Tuesday, 22 Jul at 3:00 PM"
  const m = /(\d{1,2}):(\d{2})\s*(AM|PM)/i.exec(label);
  if (!m) return -1;
  return to24(Number(m[1]), Number(m[2]), m[3].toUpperCase() as "AM" | "PM");
}

function to24(h: number, min: number, ap: "AM" | "PM"): number {
  let hr = h % 12;
  if (ap === "PM") hr += 12;
  return hr * 60 + min;
}

/** Parse "15:00", "3:00 PM", "3pm", "3 pm" → minutes since midnight, or null. */
function parseTimeToMinutes(raw: string): number | null {
  const t = raw.trim().toLowerCase();
  // 24h "HH:mm"
  let m = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(t);
  if (m) return Number(m[1]) * 60 + Number(m[2]);
  // 12h with optional minutes + am/pm
  m = /^(\d{1,2})(?::([0-5]\d))?\s*(am|pm)$/.exec(t);
  if (m) {
    const h = Number(m[1]);
    if (h < 1 || h > 12) return null;
    return to24(h, m[2] ? Number(m[2]) : 0, m[3].toUpperCase() as "AM" | "PM");
  }
  return null;
}
