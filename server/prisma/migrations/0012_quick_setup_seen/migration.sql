-- Records the first time a customer skipped/finished the quick-setup modal, so it
-- never auto-opens again across cache clears / new browsers (it only used to be
-- tracked in localStorage). Idempotent per server/MIGRATIONS.md.
ALTER TABLE "profiles" ADD COLUMN IF NOT EXISTS "quickSetupSeenAt" TIMESTAMP(3);
