-- Currency switch in flight (AUD plan -> USD plan, or any cross-currency move).
--
-- A Stripe customer is permanently locked to the currency of its first invoice,
-- so there is no API that converts an existing subscription. Moving currency
-- means minting a NEW customer and a NEW subscription, which the customer must
-- pay with a re-entered card (payment methods cannot move between customers).
--
-- These columns hold that half-built subscription between "started" and "paid".
-- The OLD subscription stays live throughout: cancel-then-create is not atomic,
-- and in that order a declined card would leave the customer with no
-- subscription at all. We cancel the old one only once the new one is active.
--
-- Abandoned switches self-heal: Stripe cancels an unpaid incomplete subscription
-- after ~23h, and starting a new switch clears whatever the last one left.
--
-- Idempotent (see server/MIGRATIONS.md).

ALTER TABLE "profiles"
  ADD COLUMN IF NOT EXISTS "pendingSwitchCustomerId" TEXT;

ALTER TABLE "profiles"
  ADD COLUMN IF NOT EXISTS "pendingSwitchSubscriptionId" TEXT;

ALTER TABLE "profiles"
  ADD COLUMN IF NOT EXISTS "pendingSwitchPlanId" TEXT;

ALTER TABLE "profiles"
  ADD COLUMN IF NOT EXISTS "pendingSwitchStartedAt" TIMESTAMP(3);
