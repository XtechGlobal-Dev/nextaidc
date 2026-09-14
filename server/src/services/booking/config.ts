import { tenantForUser } from "../tenantDb.js";
import { parseWorkingHours, type WorkingHours } from "./hours.js";

// Booking config from the CrmIntegration row. Intentionally simple: the AI books directly only when
// auto-booking is on AND Google Calendar is connected. The old "pitch a website link" path is gone.

export interface BookingConfig {
  /** Google Calendar is connected for this owner. */
  connected: boolean;
  /** Master auto-booking switch — AI may book directly when asked. */
  autoBookEnabled: boolean;
  /** AI may book directly (auto-book on AND calendar connected). */
  canAutoBook: boolean;
  /** Slot length in minutes (also the default event duration). */
  durationMin: number;
  /** Calendar to read busy time from / write events to ("primary" by default). */
  calendarId: string;
  /** IANA timezone all slots + stored times use. Falls back to UTC. */
  timezone: string;
  /** Weekly bookable window. */
  hours: WorkingHours;
  /** The business name, for professional confirmation copy. "" when unset. */
  businessName: string;
}

const DEFAULTS: BookingConfig = {
  connected: false,
  autoBookEnabled: false,
  canAutoBook: false,
  durationMin: 30,
  calendarId: "primary",
  timezone: "UTC",
  hours: parseWorkingHours(""),
  businessName: "",
};

/** Load the booking config for an owner. Best-effort — returns disabled defaults
 *  on any miss/failure so a booking tool call never crashes. */
export async function getBookingConfig(userId: string | null | undefined): Promise<BookingConfig> {
  if (!userId) return { ...DEFAULTS };
  try {
    // Booking settings and the profile are both in the brand's database.
    const db = await tenantForUser(userId);
    const [crm, profile] = await Promise.all([
      db.crmIntegration.findUnique({ where: { userId } }),
      db.profile.findUnique({ where: { userId }, select: { businessName: true } }),
    ]);
    const connected = !!crm?.googleCalendarConnected;
    const autoBookEnabled = !!crm?.bookingEnabled;
    const durationMin = crm && crm.bookingDurationMin > 0 ? crm.bookingDurationMin : 30;
    return {
      connected,
      autoBookEnabled,
      canAutoBook: connected && autoBookEnabled,
      durationMin,
      calendarId: crm?.bookingCalendarId?.trim() || "primary",
      timezone: crm?.bookingTimezone?.trim() || "UTC",
      hours: parseWorkingHours(crm?.bookingHours),
      businessName: profile?.businessName?.trim() || "",
    };
  } catch {
    return { ...DEFAULTS };
  }
}
