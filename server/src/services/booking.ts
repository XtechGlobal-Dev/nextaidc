/* ------------------------------------------------------------------ *
 *  Post-call Google Calendar booking — DISABLED.
 *
 *  Booking is now handled LIVE during the call by the Vapi booking function tools
 *  (services/booking/engine.ts + routes/bookingAi.routes.ts): the AI pitches the
 *  website, texts the link, and only books directly — with a real availability
 *  check — when the caller asks and the owner allows it. Writing a second event
 *  post-call from the transcript would DOUBLE-BOOK, so the old blind-write path is
 *  a no-op now.
 *
 *  This stub is kept only so the existing call-webhook call sites keep compiling;
 *  the call sites and this file can be removed in a later cleanup.
 * ------------------------------------------------------------------ */

/** The subset of the AI's structuredData the old path read (kept for call-site types). */
export interface BookingSignals {
  bookingRequested?: unknown;
  preferredTimeISO?: unknown;
  name?: unknown;
  phone?: unknown;
  email?: unknown;
  purpose?: unknown;
}

/** A call transcript turn (kept for call-site types). */
export interface Turn {
  role: string;
  text: string;
}

/** No-op: post-call booking has been superseded by live booking tools. */
export async function maybeCreateCalendarBooking(
  _userId: string,
  _signals: BookingSignals,
  _opts?: { transcript?: Turn[] },
): Promise<{ ok: boolean; id?: string; skipped?: string }> {
  return { ok: false, skipped: "handled-by-live-tools" };
}
