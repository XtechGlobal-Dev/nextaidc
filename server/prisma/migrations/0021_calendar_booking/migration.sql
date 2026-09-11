-- Google Calendar booking settings on a user's CRM integration.
-- bookingEnabled: master switch — AI may schedule appointments AND the server
--   creates the calendar event post-call. Independent of googleCalendarConnected
--   so a user can stay connected but pause auto-booking.
-- bookingDurationMin: slot length (minutes) for every created event.
-- bookingCalendarId: which Google calendar to write to ("primary" by default).
-- bookingTimezone: optional IANA zone stamped on the event; blank → rely on the
--   timezone offset the AI emits in the ISO start time.
ALTER TABLE "crm_integrations" ADD COLUMN IF NOT EXISTS "bookingEnabled" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "crm_integrations" ADD COLUMN IF NOT EXISTS "bookingDurationMin" INTEGER NOT NULL DEFAULT 30;
ALTER TABLE "crm_integrations" ADD COLUMN IF NOT EXISTS "bookingCalendarId" TEXT NOT NULL DEFAULT 'primary';
ALTER TABLE "crm_integrations" ADD COLUMN IF NOT EXISTS "bookingTimezone" TEXT NOT NULL DEFAULT '';
