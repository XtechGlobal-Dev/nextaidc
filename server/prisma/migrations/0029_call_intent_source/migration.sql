-- Who set call_logs.intent: 'ai' (classified on ingest) or 'user' (the owner
-- corrected it from the Call Inbox). A 'user' value is never overwritten by a
-- later AI pass — one wrong badge the owner can't fix destroys trust in all of
-- them. Idempotent (see server/MIGRATIONS.md).

ALTER TABLE "call_logs" ADD COLUMN IF NOT EXISTS "intentSource" TEXT NOT NULL DEFAULT 'ai';
