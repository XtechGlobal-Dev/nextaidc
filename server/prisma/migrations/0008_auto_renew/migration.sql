-- Auto-renew toggle on the profile (mirrors Stripe cancel_at_period_end, inverted).
ALTER TABLE "profiles" ADD COLUMN IF NOT EXISTS "autoRenew" BOOLEAN NOT NULL DEFAULT true;
