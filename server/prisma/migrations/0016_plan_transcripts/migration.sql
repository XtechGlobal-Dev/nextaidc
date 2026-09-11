-- "Summary, Transcript & Recording" is now a per-plan toggle (like SMS/WhatsApp/Custom CRM)
-- instead of a free-text bullet, so the feature order stays deterministic across all pages.
-- Defaults to true — every existing plan already advertised transcripts.
ALTER TABLE "subscription_plans" ADD COLUMN IF NOT EXISTS "transcriptsEnabled" BOOLEAN NOT NULL DEFAULT true;
