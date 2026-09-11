-- Per-plan feature entitlement flags (replace the old add-on products).
ALTER TABLE "subscription_plans" ADD COLUMN IF NOT EXISTS "smsEnabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "subscription_plans" ADD COLUMN IF NOT EXISTS "whatsappEnabled" BOOLEAN NOT NULL DEFAULT false;

-- Add-ons are gone — features are now bundled into plan tiers. Drop the purchase
-- records first (FK), then the catalog table.
DROP TABLE IF EXISTS "user_addons";
DROP TABLE IF EXISTS "addons";
