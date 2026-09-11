-- "Prompt optimised" feature columns. Regional/industry context fed into the
-- assistant prompt (profiles.country / profiles.industry) and the per-conversation
-- frozen prompt-template snapshot (conversions.promptTemplateSnapshot). Additive
-- and idempotent so it's safe to re-run and stays consistent with the
-- render:build `prisma db push` reconciliation.
ALTER TABLE "profiles" ADD COLUMN IF NOT EXISTS "country" TEXT NOT NULL DEFAULT '';
ALTER TABLE "profiles" ADD COLUMN IF NOT EXISTS "industry" TEXT NOT NULL DEFAULT '';
ALTER TABLE "conversions" ADD COLUMN IF NOT EXISTS "promptTemplateSnapshot" TEXT;
