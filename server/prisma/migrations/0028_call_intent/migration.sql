-- Call intent: what the call was about (booking / lead / enquiry / support /
-- spam), powering the Call Inbox badge + filter. Plain TEXT rather than an enum
-- so new categories need no migration. Existing rows stay '' (unclassified) and
-- simply render without a badge. Idempotent (see server/MIGRATIONS.md).

ALTER TABLE "call_logs" ADD COLUMN IF NOT EXISTS "intent" TEXT NOT NULL DEFAULT '';

-- Filtering the inbox by category is a per-tenant, newest-first scan.
CREATE INDEX IF NOT EXISTS "call_logs_conversionId_intent_idx"
  ON "call_logs" ("conversionId", "intent");
