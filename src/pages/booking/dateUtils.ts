/* Small timezone-aware date helpers for the Booking calendar. No date library on
 * the frontend, so we lean on Intl.DateTimeFormat with the owner's IANA timezone
 * for anything that must render in their local time. Grid math uses local Date. */

/** "YYYY-MM-DD" from a Date's LOCAL calendar fields (for grid day keys). */
export function ymd(d: Date): string {
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${m}-${day}`;
}

/** ms that `tz` is ahead of UTC at the given instant. */
function tzOffsetMs(utcMs: number, tz: string): number {
  try {
    const dtf = new Intl.DateTimeFormat("en-US", {
      timeZone: tz || "UTC",
      hour12: false,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    const parts = dtf.formatToParts(new Date(utcMs));
    const map: Record<string, number> = {};
    for (const p of parts) if (p.type !== "literal") map[p.type] = Number(p.value);
    const asUTC = Date.UTC(
      map.year,
      map.month - 1,
      map.day,
      map.hour === 24 ? 0 : map.hour,
      map.minute,
      map.second,
    );
    return asUTC - utcMs;
  } catch {
    return 0;
  }
}

/** The calendar day ("YYYY-MM-DD") an instant falls on in the owner's timezone. */
export function zonedYmd(iso: string, tz: string): string {
  try {
    const dtf = new Intl.DateTimeFormat("en-CA", {
      timeZone: tz || "UTC",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
    return dtf.format(new Date(iso)); // en-CA → YYYY-MM-DD
  } catch {
    return iso.slice(0, 10);
  }
}

/** Human time label (e.g. "3:00 PM") for an instant, in the owner's timezone. */
export function zonedTime(iso: string, tz: string): string {
  try {
    return new Intl.DateTimeFormat(undefined, {
      timeZone: tz || "UTC",
      hour: "numeric",
      minute: "2-digit",
    }).format(new Date(iso));
  } catch {
    return iso;
  }
}

/** Parts for a compact date tile (month/day/weekday), in the owner's timezone. */
export function zonedTile(iso: string, tz: string): { month: string; day: string; weekday: string } {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: tz || "UTC",
      month: "short",
      day: "numeric",
      weekday: "short",
    }).formatToParts(new Date(iso));
    const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
    return { month: get("month"), day: get("day"), weekday: get("weekday") };
  } catch {
    return { month: "", day: iso.slice(8, 10), weekday: "" };
  }
}

/** Full label (e.g. "Tue, 22 Jul, 3:00 PM") for an instant, in the owner's tz. */
export function zonedFull(iso: string, tz: string): string {
  try {
    return new Intl.DateTimeFormat(undefined, {
      timeZone: tz || "UTC",
      weekday: "short",
      day: "numeric",
      month: "short",
      hour: "numeric",
      minute: "2-digit",
    }).format(new Date(iso));
  } catch {
    return iso;
  }
}

/**
 * Convert an owner-entered wall-clock (date "YYYY-MM-DD" + time "HH:mm" meant in
 * `tz`) to a UTC ISO string the server can store. Uses one offset correction pass
 * — accurate except at the rare DST-gap boundary, which real slot times avoid.
 */
export function zonedWallToUtcISO(dateStr: string, timeStr: string, tz: string): string {
  const naive = Date.parse(`${dateStr}T${timeStr}:00Z`);
  if (Number.isNaN(naive)) return new Date().toISOString();
  const offset = tzOffsetMs(naive, tz);
  return new Date(naive - offset).toISOString();
}

/** Add days to a date (returns a new Date, local). */
export function addDays(d: Date, n: number): Date {
  const c = new Date(d);
  c.setDate(c.getDate() + n);
  return c;
}

/** Add months to a date (returns a new Date, local). */
export function addMonths(d: Date, n: number): Date {
  const c = new Date(d);
  c.setMonth(c.getMonth() + n);
  return c;
}

/** The Sunday that starts the week containing `d`. */
export function startOfWeek(d: Date): Date {
  const c = new Date(d);
  c.setHours(0, 0, 0, 0);
  c.setDate(c.getDate() - c.getDay());
  return c;
}

/** The 42-day (6-week) grid covering the month of `d`, starting on Sunday. */
export function monthGrid(d: Date): Date[] {
  const first = new Date(d.getFullYear(), d.getMonth(), 1);
  const start = startOfWeek(first);
  return Array.from({ length: 42 }, (_, i) => addDays(start, i));
}

export const WEEKDAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;
