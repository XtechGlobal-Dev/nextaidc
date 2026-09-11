-- Reverts 0037_recording_share.
--
-- The short share-link feature it was added for was dropped before shipping, so
-- these columns never held a row. Removed rather than left behind: an unused
-- nullable column with a unique index reads like a feature someone forgot to
-- finish, and the next person would have to work out which it was.
DROP INDEX IF EXISTS "call_logs_recordingShareId_key";

ALTER TABLE "call_logs"
  DROP COLUMN IF EXISTS "recordingShareId",
  DROP COLUMN IF EXISTS "recordingShareExpiresAt";
