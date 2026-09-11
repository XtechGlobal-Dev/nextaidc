-- Custom CRM (webhook) lead delivery is a per-plan entitlement, like SMS/WhatsApp.
ALTER TABLE "subscription_plans" ADD COLUMN IF NOT EXISTS "customCrmEnabled" BOOLEAN NOT NULL DEFAULT false;
