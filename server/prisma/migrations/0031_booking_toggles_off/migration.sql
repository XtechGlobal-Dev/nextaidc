-- Booking is opt-in: both toggles now default OFF, so a new account never has
-- its AI promising an online booking page or writing to a calendar until the
-- owner deliberately switches it on.
--
-- Backfill policy differs per column, on purpose:
--
--  * bookingLinkEnabled — added earlier today (0030) with a default of true, so
--    NO owner has ever chosen its value. Reset every row to false so the stored
--    state matches the new opt-in default. Effect: the AI stops pitching a
--    website until the owner turns the toggle on. That is the intent — a site
--    that can't take bookings must not be offered as one.
--
--  * bookingEnabled (auto-book via Google Calendar) — a long-standing setting
--    that owners may be actively relying on. Only the DEFAULT changes here;
--    existing rows keep their value. Flipping a live customer's auto-booking off
--    would silently stop appointments being written to their calendar, which is
--    a destructive change and needs its own explicit, authorized migration.
--
-- Idempotent (see server/MIGRATIONS.md).

ALTER TABLE "crm_integrations" ALTER COLUMN "bookingLinkEnabled" SET DEFAULT false;
ALTER TABLE "crm_integrations" ALTER COLUMN "bookingEnabled" SET DEFAULT false;

UPDATE "crm_integrations" SET "bookingLinkEnabled" = false WHERE "bookingLinkEnabled" = true;
