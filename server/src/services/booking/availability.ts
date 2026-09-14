import { tenantForUser } from "../tenantDb.js";
import { getFreeBusy, type BusyInterval } from "../google.js";
import { generateSlots, type Slot, type WorkingHours } from "./hours.js";

// Availability = open window minus busy time (Google freeBusy + confirmed Appointments, since the
// Google write is fire-and-forget and may lag). No capacity or per-day cap — window + busy only.

export interface AvailabilityInput {
  userId: string;
  /** YYYY-MM-DD in the owner's timezone. */
  dateISO: string;
  hours: WorkingHours;
  durationMin: number;
  timezone: string;
  calendarId: string;
  /** When true, subtract Google freeBusy (owner is connected). */
  useGoogle: boolean;
  /** Injected in tests; defaults to real "now". */
  now?: Date;
}

/** Two [start,end) instants overlap. */
function overlaps(aStart: number, aEnd: number, bStart: number, bEnd: number): boolean {
  return aStart < bEnd && bStart < aEnd;
}

/** Open slots for a date, chronological. Google errors degrade to "internal busy only" rather than throwing. */
export async function computeAvailability(input: AvailabilityInput): Promise<Slot[]> {
  const now = (input.now ?? new Date()).getTime();
  const candidates = generateSlots(input.dateISO, input.hours, input.durationMin, input.timezone);
  // Future only.
  const future = candidates.filter((s) => new Date(s.startISO).getTime() > now);
  if (!future.length) return [];

  // Window bounds for the busy queries (first slot start … last slot end).
  const windowStart = future[0].startISO;
  const windowEnd = future[future.length - 1].endISO;

  const busy: BusyInterval[] = [];

  if (input.useGoogle) {
    const gb = await getFreeBusy(input.userId, windowStart, windowEnd, [input.calendarId]);
    busy.push(...gb);
  }

  // Internal confirmed appointments overlapping the window.
  try {
    const appts = await (await tenantForUser(input.userId)).appointment.findMany({
      where: {
        userId: input.userId,
        status: "confirmed",
        startAt: { lt: new Date(windowEnd) },
        endAt: { gt: new Date(windowStart) },
      },
      select: { startAt: true, endAt: true },
    });
    for (const a of appts) busy.push({ start: a.startAt.toISOString(), end: a.endAt.toISOString() });
  } catch {
    /* best-effort — Google busy still applies */
  }

  const busyMs = busy.map((b) => ({ start: new Date(b.start).getTime(), end: new Date(b.end).getTime() }));

  return future.filter((s) => {
    const ss = new Date(s.startISO).getTime();
    const se = new Date(s.endISO).getTime();
    return !busyMs.some((b) => overlaps(ss, se, b.start, b.end));
  });
}
