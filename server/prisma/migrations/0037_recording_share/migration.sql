-- Short share links for call recordings.
--
-- The owner's "Copy link" action mints a slug and a 7-day expiry. Kept apart
-- from publicId/shareExpiresAt (the conversation page) so sharing audio never
-- exposes the transcript page, and so the two expiries can't overwrite one
-- another.
ALTER TABLE "call_logs"
  ADD COLUMN IF NOT EXISTS "recordingShareId" TEXT,
  ADD COLUMN IF NOT EXISTS "recordingShareExpiresAt" TIMESTAMP(3);

CREATE UNIQUE INDEX IF NOT EXISTS "call_logs_recordingShareId_key"
  ON "call_logs"("recordingShareId");
