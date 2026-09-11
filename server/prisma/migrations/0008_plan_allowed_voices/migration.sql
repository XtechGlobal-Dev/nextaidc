-- Plan-gated voice selection: each plan unlocks a set of ElevenLabs voice ids.
-- Idempotent (shared Neon DB may be partially ahead) — see server/MIGRATIONS.md.
ALTER TABLE "subscription_plans"
  ADD COLUMN IF NOT EXISTS "allowedVoices" JSONB NOT NULL DEFAULT '[]';
