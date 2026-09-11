-- Structured weekly availability (JSON string) for calendar bookings, chosen in
-- Account Settings. Per-day {enabled, open, close}. Blank = not set (AI falls
-- back to the free-text businessHours). The dashboard also compiles this into
-- the agent's businessHours on save so the live agent knows the timings.
ALTER TABLE "crm_integrations" ADD COLUMN IF NOT EXISTS "bookingHours" TEXT NOT NULL DEFAULT '';
