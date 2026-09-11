-- Auto-retry for failed pushes of a saved agent config to the live Vapi assistant.
--
-- Saving the AI Brain writes the DB first and pushes to Vapi second, on purpose:
-- a provider outage must never lose the owner's edits. The gap was that a failed
-- push was only logged. The config sat in the DB looking saved while real callers
-- kept hearing the previous script, and nothing ever retried — the owner had to
-- notice and press Save again, which they had no reason to do.
--
-- These columns turn that failure into queued work the scheduler drains:
--   vapiSyncPendingAt  first time the live assistant fell behind (null = in sync)
--   vapiSyncNextAt     when the next retry is due (exponential backoff)
--   vapiSyncAttempts   consecutive failures — drives backoff + the stuck alert
--   vapiSyncError      last failure reason, for support
--
-- All nullable / defaulted, so every existing row reads as "in sync" — correct,
-- since those configs were pushed successfully under the old code path.
--
-- Idempotent (see server/MIGRATIONS.md).

ALTER TABLE "conversions"
  ADD COLUMN IF NOT EXISTS "vapiSyncPendingAt" TIMESTAMP(3);

ALTER TABLE "conversions"
  ADD COLUMN IF NOT EXISTS "vapiSyncNextAt" TIMESTAMP(3);

ALTER TABLE "conversions"
  ADD COLUMN IF NOT EXISTS "vapiSyncAttempts" INTEGER NOT NULL DEFAULT 0;

ALTER TABLE "conversions"
  ADD COLUMN IF NOT EXISTS "vapiSyncError" TEXT;

-- The sweep runs every few minutes and asks only for rows whose retry is due;
-- without this it degrades into a full scan of every account as the table grows.
CREATE INDEX IF NOT EXISTS "conversions_vapiSyncNextAt_idx"
  ON "conversions" ("vapiSyncNextAt");
