-- Admin account lock. Set when an admin manually suspends a customer; cleared on
-- reactivate. Distinct from a grace-lapsed subscriptionStatus="suspended" (which
-- a customer can self-recover from via /subscribe): an admin lock blocks login
-- entirely and can only be lifted by an admin.
-- Idempotent so it can be applied safely against the already-diverged DB
-- (see server/MIGRATIONS.md).
ALTER TABLE "profiles" ADD COLUMN IF NOT EXISTS "suspendedAt" TIMESTAMP(3);
