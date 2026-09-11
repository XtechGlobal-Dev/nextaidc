-- Remove usage-based overage billing: drop the per-minute overage rate from plans.
ALTER TABLE "subscription_plans" DROP COLUMN IF EXISTS "overagePerMinuteCents";
