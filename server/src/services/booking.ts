// Post-call booking is DISABLED: booking happens live on the call (booking/engine.ts), and a
// second post-call write from the transcript would double-book. Stub kept only so call sites compile.

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
