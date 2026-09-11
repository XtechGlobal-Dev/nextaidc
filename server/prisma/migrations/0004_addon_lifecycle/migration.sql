-- Add-ons become one-time, minute-granting purchases with their own validity window.

ALTER TABLE "addons" ADD COLUMN IF NOT EXISTS "includedMinutes" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "addons" ADD COLUMN IF NOT EXISTS "durationDays" INTEGER NOT NULL DEFAULT 30;

ALTER TABLE "user_addons" ADD COLUMN IF NOT EXISTS "minutesGranted" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "user_addons" ADD COLUMN IF NOT EXISTS "minutesUsed" DOUBLE PRECISION NOT NULL DEFAULT 0;
ALTER TABLE "user_addons" ADD COLUMN IF NOT EXISTS "purchasedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE "user_addons" ADD COLUMN IF NOT EXISTS "expiresAt" TIMESTAMP(3);
ALTER TABLE "user_addons" ADD COLUMN IF NOT EXISTS "status" TEXT NOT NULL DEFAULT 'active';
ALTER TABLE "user_addons" ADD COLUMN IF NOT EXISTS "stripePaymentIntentId" TEXT;
ALTER TABLE "user_addons" ADD COLUMN IF NOT EXISTS "stripeInvoiceId" TEXT;

-- A user can re-buy the same add-on after a prior one expires → drop the unique pair.
DROP INDEX IF EXISTS "user_addons_userId_addonId_key";
CREATE INDEX IF NOT EXISTS "user_addons_userId_status_idx" ON "user_addons" ("userId", "status");
