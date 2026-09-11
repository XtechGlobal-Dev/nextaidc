-- The Stripe invoice a coupon cycle was last counted for. One paid invoice is
-- exactly one charge is exactly one cycle, so this is the precise idempotency
-- key for consumeCycle.
--
-- lastCountedPeriodEnd alone could not do the job: an early renewal (triggered
-- when a customer burns their plan minutes) anchors the new cycle at "now", so
-- two renewals on the same day report period ends only minutes apart. The
-- one-hour "same period" window then discarded the second charge as a duplicate
-- event, cycles stopped being counted, and the `forever` Stripe coupon behind
-- every multi-cycle discount was never detached — a 2-cycle coupon kept
-- discounting indefinitely.
--
-- No backfill: null means "no charge counted by invoice id yet", and the period
-- end stays as the fallback, so live redemptions carry on unchanged.
-- Idempotent (see server/MIGRATIONS.md).
ALTER TABLE "coupon_redemptions"
  ADD COLUMN IF NOT EXISTS "lastCountedInvoiceId" TEXT;
