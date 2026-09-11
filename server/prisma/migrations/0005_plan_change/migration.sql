-- Pending-downgrade tracking on the profile (scheduled plan change at period end).
ALTER TABLE "profiles" ADD COLUMN IF NOT EXISTS "scheduledPlanId" TEXT;
ALTER TABLE "profiles" ADD COLUMN IF NOT EXISTS "scheduledPlanEffectiveAt" TIMESTAMP(3);
ALTER TABLE "profiles" ADD COLUMN IF NOT EXISTS "stripeScheduleId" TEXT;
