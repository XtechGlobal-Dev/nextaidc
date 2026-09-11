-- Track which usage-alert thresholds (50/80/90%) have already been emailed for
-- the current cycle, so the owner is notified at most once per crossing.
-- Idempotent so it can be applied safely against the already-diverged DB
-- (see server/MIGRATIONS.md).
ALTER TABLE "profiles" ADD COLUMN IF NOT EXISTS "usageAlertsSent" TEXT NOT NULL DEFAULT '';
