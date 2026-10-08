-- Speed for a database per account (docs/brand-as-customer-plan.md): questions asked on a live request are answered
-- from Main, never by opening every account database in turn.
--
-- 1. The Vapi webhook finds the account behind an assistant from Main (services/assistantOwner.ts); number-bound
--    assistants are found by this column.
-- 2. `coupon_holds`: one row per coupon slot held by a checkout in progress, so a limited coupon's supply is
--    counted with one indexed read (services/coupons.ts) instead of a count in every account database — a count
--    that used to run inside the checkout's own transaction.
--
-- Idempotent (see server/MIGRATIONS.md).

CREATE INDEX IF NOT EXISTS "phone_numbers_assistantId_idx" ON "phone_numbers" ("assistantId");

CREATE TABLE IF NOT EXISTS "coupon_holds" (
  "couponId"   TEXT NOT NULL,
  "brandId"    TEXT NOT NULL,
  "userId"     TEXT NOT NULL,
  "reservedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "coupon_holds_pkey" PRIMARY KEY ("couponId", "brandId", "userId")
);
CREATE INDEX IF NOT EXISTS "coupon_holds_couponId_reservedAt_idx" ON "coupon_holds" ("couponId", "reservedAt");
CREATE INDEX IF NOT EXISTS "coupon_holds_reservedAt_idx" ON "coupon_holds" ("reservedAt");
