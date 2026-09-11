-- Make the ONE booking engine adapt to any business type via configuration
-- instead of hardcoding verticals.
-- bookingLabel: what's being booked in the owner's words (drives AI language +
--   event title). e.g. "appointment", "table reservation", "job/visit".
-- bookingFields: JSON string array of extra detail labels the AI should collect
--   for a booking (e.g. ["Party size","Address"]). Blank/[] = basics only.
ALTER TABLE "crm_integrations" ADD COLUMN IF NOT EXISTS "bookingLabel" TEXT NOT NULL DEFAULT 'appointment';
ALTER TABLE "crm_integrations" ADD COLUMN IF NOT EXISTS "bookingFields" TEXT NOT NULL DEFAULT '';
