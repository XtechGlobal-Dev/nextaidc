-- When the account's FIRST card was confirmed (/billing/confirm-card is the only
-- writer). null = no card has ever landed, which is what the onboarding card wall
-- keys on. subscriptionStatus can't be used for that: the Stripe webhook mirrors
-- it, and /subscribe opens a real trial subscription before any card exists, so
-- Stripe reports "trialing" and the mirror would silently lift the wall.
--
-- No backfill. Existing accounts read null, which is correct for them either way:
-- the wall only ever applies to rows with cardRequiredAtSignup = true, and every
-- pre-existing row has that false.
-- Idempotent (see server/MIGRATIONS.md).
ALTER TABLE "profiles"
  ADD COLUMN IF NOT EXISTS "cardConfirmedAt" TIMESTAMP(3);
