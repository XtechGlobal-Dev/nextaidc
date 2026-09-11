-- Snapshot of the platform's `onboarding.cardRequired` setting at the moment the
-- account was created. Read once in createUser, never again — so flipping the
-- admin toggle can't retroactively wall a live customer.
-- No backfill: every EXISTING row takes the DEFAULT false, i.e. keeps the
-- card-less free trial it signed up under. That is intentional and load-bearing.
-- Idempotent (see server/MIGRATIONS.md).
ALTER TABLE "profiles"
  ADD COLUMN IF NOT EXISTS "cardRequiredAtSignup" BOOLEAN NOT NULL DEFAULT false;
