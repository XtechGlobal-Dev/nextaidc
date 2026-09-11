-- Pre-selected plan on the onboarding subscribe page (at most one plan is default).
ALTER TABLE "subscription_plans" ADD COLUMN IF NOT EXISTS "isDefault" BOOLEAN NOT NULL DEFAULT false;
