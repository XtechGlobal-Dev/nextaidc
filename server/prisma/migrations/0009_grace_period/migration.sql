-- Post-trial grace period: hold a lapsed trial's number before releasing it.
ALTER TABLE "profiles" ADD COLUMN IF NOT EXISTS "graceStartedAt" TIMESTAMP(3);
ALTER TABLE "profiles" ADD COLUMN IF NOT EXISTS "graceEndsAt" TIMESTAMP(3);
ALTER TABLE "profiles" ADD COLUMN IF NOT EXISTS "graceNotifyStage" TEXT;
ALTER TABLE "profiles" ADD COLUMN IF NOT EXISTS "graceConsumedAt" TIMESTAMP(3);
