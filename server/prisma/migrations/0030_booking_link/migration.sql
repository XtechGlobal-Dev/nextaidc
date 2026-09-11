-- Online-booking link settings.
--
-- bookingUrl is the page the AI pitches and texts. It is deliberately separate
-- from profiles.website (the marketing site, also the source for onboarding's
-- site analysis) because the booking page is usually a subpage or a third party
-- — OpenTable, ResDiary, Calendly. Blank falls back to profiles.website, so
-- owners who never open this setting see no change.
--
-- bookingLinkEnabled defaults TRUE to preserve today's behaviour exactly: every
-- owner with a website already gets the pitch. Defaulting it FALSE would have
-- silently stopped the pitch for every business whose booking flow works. The
-- toggle exists so an owner whose site has NO booking page can stop the AI
-- promising one.
--
-- Idempotent (see server/MIGRATIONS.md).

ALTER TABLE "crm_integrations"
  ADD COLUMN IF NOT EXISTS "bookingLinkEnabled" BOOLEAN NOT NULL DEFAULT true;

ALTER TABLE "crm_integrations"
  ADD COLUMN IF NOT EXISTS "bookingUrl" TEXT NOT NULL DEFAULT '';
