-- Multi-month billing cycles: quarterly, half-yearly, annual.
--
-- Stripe expresses a cycle as `recurring: { interval, interval_count }`, so
-- "every 3 months" is interval="month" with interval_count=3. This column is
-- that count. Stripe caps a cycle at one year, so with interval="month" the
-- value may not exceed 12 (enforced in the plan input schema).
--
-- DEFAULT 1 makes every existing plan exactly what it already is — monthly —
-- so this deploys with no behaviour change and no backfill.
--
-- Note on `includedMinutes`: it stays the total for the WHOLE cycle rather than
-- a per-month figure. That is what the field's label already promises
-- ("granted each billing period"), it keeps the allowance and renewal logic
-- unaware of cycle length, and it avoids a number on screen that differs from
-- the number granted. Only MRR normalisation divides by this count.
--
-- Idempotent (see server/MIGRATIONS.md).

ALTER TABLE "subscription_plans"
  ADD COLUMN IF NOT EXISTS "intervalCount" INTEGER NOT NULL DEFAULT 1;
