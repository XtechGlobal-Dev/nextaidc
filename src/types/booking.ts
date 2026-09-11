/* Types for the website-first Booking module (mirrors the server DTOs). */

export type AppointmentStatus = "confirmed" | "cancelled";
export type AppointmentSource = "ai" | "manual";

export interface Appointment {
  id: string;
  customerName: string;
  customerPhone: string;
  customerEmail: string;
  notes: string;
  /** UTC ISO datetime. */
  startAt: string;
  /** UTC ISO datetime. */
  endAt: string;
  /** Owner's IANA timezone the slot was generated in. */
  timezone: string;
  status: AppointmentStatus;
  source: AppointmentSource;
  /** Whether a Google Calendar event is linked. */
  hasEvent: boolean;
  createdAt: string;
}

/** One weekday's opening rule. `open` false = closed. */
export interface DayHours {
  open: boolean;
  /** Local "HH:mm" (24h). */
  start: string;
  /** Local "HH:mm" (24h). */
  end: string;
}

/** Per-weekday hours keyed by JS weekday index "0" (Sun) … "6" (Sat). */
export type WorkingHours = Record<string, DayHours>;

export interface BookingSettings {
  connected: boolean;
  autoBookEnabled: boolean;
  durationMin: number;
  calendarId: string;
  timezone: string;
  hours: WorkingHours;
}

export interface BookingOverview {
  connected: boolean;
  autoBookEnabled: boolean;
  canAutoBook: boolean;
  timezone: string;
  todayCount: number;
  upcoming: Appointment[];
}
