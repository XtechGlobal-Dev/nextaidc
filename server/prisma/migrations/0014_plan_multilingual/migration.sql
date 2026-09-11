-- Multilingual answering is a per-plan entitlement, like SMS/WhatsApp/Custom CRM.
-- Customers on a multilingual plan pick their languages in the AI Brain (identity.languages).
ALTER TABLE "subscription_plans" ADD COLUMN IF NOT EXISTS "multilingualEnabled" BOOLEAN NOT NULL DEFAULT false;
