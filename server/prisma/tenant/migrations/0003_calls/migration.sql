-- Phase 2a — calls live whole in the brand's own database.
--
-- Until now a brand's database held only the caller-personal half of each call
-- (call_details), keyed to a structural row in the control plane. That split
-- goes: the whole call is written here, and the control plane's call_logs is
-- left to empty out. Same partitioning (one partition per month on createdAt),
-- same indexes, plus the trigram indexes the inbox search needs.

-- A call_details row without its structural half cannot be folded into a whole
-- call here, so any that exist must be moved by provisioning first. None ever
-- were — the old split never ran against a real database — but refuse loudly
-- rather than drop a customer's transcripts.
DO $$
DECLARE remaining bigint;
BEGIN
  SELECT count(*) INTO remaining FROM "call_details";
  IF remaining > 0 THEN
    RAISE EXCEPTION 'call_details still holds % row(s); fold them into call_logs before applying 0003_calls', remaining;
  END IF;
END $$;

CREATE TYPE "CallType" AS ENUM ('Web', 'Phone');
CREATE TYPE "CallOutcome" AS ENUM ('completed', 'missed', 'failed', 'voicemail');

CREATE TABLE "call_logs" (
    "id"                       TEXT          NOT NULL,
    "conversionId"             TEXT          NOT NULL,
    "type"                     "CallType"    NOT NULL DEFAULT 'Web',
    "callerName"               TEXT          NOT NULL DEFAULT 'Unknown',
    "callerNumber"             TEXT          NOT NULL DEFAULT '',
    "durationSec"              INTEGER       NOT NULL DEFAULT 0,
    "outcome"                  "CallOutcome" NOT NULL DEFAULT 'completed',
    "summary"                  TEXT          NOT NULL DEFAULT '',
    "purpose"                  TEXT          NOT NULL DEFAULT '',
    "intent"                   TEXT          NOT NULL DEFAULT '',
    "intentSource"             TEXT          NOT NULL DEFAULT 'ai',
    "requestedDepartment"      TEXT          NOT NULL DEFAULT '',
    "transferOutcome"          TEXT          NOT NULL DEFAULT '',
    "recordingUrl"             TEXT,
    "vapiCallId"               TEXT,
    "transcript"               JSONB         NOT NULL DEFAULT '[]',
    "analysis"                 JSONB         NOT NULL DEFAULT '{}',
    "transcriptTranslated"     JSONB,
    "transcriptTranslatedLang" TEXT,
    "summaryTranslated"        TEXT,
    "publicId"                 TEXT,
    "shareExpiresAt"           TIMESTAMP(3),
    "blobKey"                  TEXT,
    "blobArchivedAt"           TIMESTAMP(3),
    "createdAt"                TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "call_logs_pkey" PRIMARY KEY ("id", "createdAt")
) PARTITION BY RANGE ("createdAt");

-- Catch-all: a late partition sweep must never be able to reject a write and
-- lose a real customer conversation.
CREATE TABLE "call_logs_default" PARTITION OF "call_logs" DEFAULT;

CREATE UNIQUE INDEX "call_logs_publicId_createdAt_key" ON "call_logs" ("publicId", "createdAt");
CREATE INDEX "call_logs_conversionId_createdAt_idx"    ON "call_logs" ("conversionId", "createdAt");
CREATE INDEX "call_logs_conversionId_intent_idx"       ON "call_logs" ("conversionId", "intent");
CREATE INDEX "call_logs_createdAt_idx"                 ON "call_logs" ("createdAt");

-- The inbox search matches on caller name and summary; trigram indexes so
-- `contains` is not a scan. pg_trgm was pinned to `public` by 0001.
CREATE INDEX "call_logs_callerName_trgm" ON "call_logs" USING gin ("callerName" public.gin_trgm_ops);
CREATE INDEX "call_logs_summary_trgm"    ON "call_logs" USING gin ("summary" public.gin_trgm_ops);

-- The old half-table, partitions and all.
DROP TABLE "call_details";
