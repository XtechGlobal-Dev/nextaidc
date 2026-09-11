import dayjs from "dayjs";
import utc from "dayjs/plugin/utc.js";
import timezone from "dayjs/plugin/timezone.js";
import customParseFormat from "dayjs/plugin/customParseFormat.js";

dayjs.extend(utc);
dayjs.extend(timezone);
dayjs.extend(customParseFormat);

/* ------------------------------------------------------------------ *
 *  Booking working hours + slot generation (timezone/DST-safe).
 *
 *  The owner's bookable window is defined ONLY by working days + open/close
 *  times + slot length — no per-service capacity, no resources. Slots for a date
 *  are generated in the owner's IANA timezone and returned as UTC instants, so
 *  a slot that straddles a DST change lands at the correct wall-clock time.
 * ------------------------------------------------------------------ */

/** One weekday's opening rule. `open` false = closed all day. */
export interface DayHours {
  open: boolean;
  /** Local "HH:mm" (24h). Ignored when `open` is false. */
  start: string;
  /** Local "HH:mm" (24h). Ignored when `open` is false. */
  end: string;
}

/** Per-weekday hours keyed by JS weekday index (0=Sun … 6=Sat). */
export type WorkingHours = Record<number, DayHours>;

const HHMM = /^([01]?\d|2[0-3]):([0-5]\d)$/;

/** Default hours: Mon–Fri 09:00–17:00, weekends closed. */
export function defaultWorkingHours(): WorkingHours {
  const weekday: DayHours = { open: true, start: "09:00", end: "17:00" };
  const closed: DayHours = { open: false, start: "09:00", end: "17:00" };
  return { 0: closed, 1: { ...weekday }, 2: { ...weekday }, 3: { ...weekday }, 4: { ...weekday }, 5: { ...weekday }, 6: closed };
}

function coerceDay(raw: unknown): DayHours | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const start = typeof r.start === "string" && HHMM.test(r.start) ? r.start : "09:00";
  const end = typeof r.end === "string" && HHMM.test(r.end) ? r.end : "17:00";
  const open = r.open === true || r.open === "true";
  return { open, start, end };
}

/** Parse the JSON stored in `CrmIntegration.bookingHours` into a full 7-day map,
 *  filling any missing/invalid day from the defaults. Blank → defaults. Never throws. */
export function parseWorkingHours(raw: string | null | undefined): WorkingHours {
  const base = defaultWorkingHours();
  if (!raw || !raw.trim()) return base;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    for (let d = 0; d < 7; d++) {
      const day = coerceDay(parsed[String(d)]);
      if (day) base[d] = day;
    }
  } catch {
    /* malformed → defaults */
  }
  return base;
}

/** Serialize a working-hours map back to the stored JSON string. */
export function serializeWorkingHours(hours: WorkingHours): string {
  const out: Record<string, DayHours> = {};
  for (let d = 0; d < 7; d++) {
    const day = hours[d] ?? defaultWorkingHours()[d];
    out[String(d)] = {
      open: !!day.open,
      start: HHMM.test(day.start) ? day.start : "09:00",
      end: HHMM.test(day.end) ? day.end : "17:00",
    };
  }
  return JSON.stringify(out);
}

/** A candidate bookable slot for a date, as UTC instants + a local display label. */
export interface Slot {
  /** Slot start as a UTC ISO string. */
  startISO: string;
  /** Slot end as a UTC ISO string. */
  endISO: string;
  /** Local time label in the owner's timezone, e.g. "9:00 AM". */
  label: string;
}

function toMinutes(hhmm: string): number {
  const m = HHMM.exec(hhmm);
  if (!m) return NaN;
  return Number(m[1]) * 60 + Number(m[2]);
}

/**
 * Generate every candidate slot for `dateISO` (YYYY-MM-DD, interpreted in `tz`)
 * from the day's open/close window, stepping by `durationMin`. A slot is included
 * only when it fits entirely inside the window (start + duration ≤ close). Times
 * are built with dayjs.tz so DST is handled correctly. Returns [] for a closed
 * day, a bad date, or a non-positive duration.
 */
export function generateSlots(
  dateISO: string,
  hours: WorkingHours,
  durationMin: number,
  tz: string,
): Slot[] {
  const zone = tz && tz.trim() ? tz.trim() : "UTC";
  const duration = Math.floor(durationMin);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateISO) || duration <= 0) return [];

  // Weekday in the owner's timezone (a date near midnight can be a different
  // weekday in UTC, so resolve it in-zone).
  const dayStart = dayjs.tz(`${dateISO} 00:00`, "YYYY-MM-DD HH:mm", zone);
  if (!dayStart.isValid()) return [];
  const weekday = dayStart.day();

  const rule = hours[weekday];
  if (!rule || !rule.open) return [];

  const openMin = toMinutes(rule.start);
  const closeMin = toMinutes(rule.end);
  if (Number.isNaN(openMin) || Number.isNaN(closeMin) || closeMin <= openMin) return [];

  const slots: Slot[] = [];
  for (let m = openMin; m + duration <= closeMin; m += duration) {
    const start = dayStart.add(m, "minute");
    const end = start.add(duration, "minute");
    slots.push({
      startISO: start.utc().toISOString(),
      endISO: end.utc().toISOString(),
      label: start.format("h:mm A"),
    });
  }
  return slots;
}

/** Format a UTC instant as a friendly local string in the owner's timezone,
 *  e.g. "Tuesday, 22 Jul at 3:00 PM". Used in SMS + tool replies. */
export function formatLocal(instantISO: string, tz: string): string {
  const zone = tz && tz.trim() ? tz.trim() : "UTC";
  const d = dayjs.utc(instantISO).tz(zone);
  return d.isValid() ? d.format("dddd, D MMM [at] h:mm A") : instantISO;
}

/** Today's date (YYYY-MM-DD) and weekday name in the owner's timezone — injected
 *  into the AI prompt so it resolves relative dates ("tomorrow", "next Tuesday"). */
export function todayInZone(tz: string): { dateISO: string; weekday: string; nowISO: string } {
  const zone = tz && tz.trim() ? tz.trim() : "UTC";
  const now = dayjs().tz(zone);
  return { dateISO: now.format("YYYY-MM-DD"), weekday: now.format("dddd"), nowISO: now.utc().toISOString() };
}
