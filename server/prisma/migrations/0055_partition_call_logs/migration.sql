-- Convert `call_logs` to a RANGE-partitioned table, one partition per month.
--
-- WHY
--   Retention on a huge table is a mass DELETE: it rewrites pages, bloats the
--   heap, and leaves autovacuum to catch up for hours. `DROP TABLE` on a
--   partition is a catalogue update — effectively instant, and it returns the
--   disk immediately. Queries also stop touching months they don't need: the
--   inbox reads "this brand, newest first", which prunes to one or two
--   partitions instead of scanning an index over the whole history.
--
-- THE COST, STATED PLAINLY
--   Postgres requires the partition key in every unique constraint. So the
--   primary key becomes (id, createdAt) and the share slug is unique on
--   (publicId, createdAt). A lookup by `id` alone can no longer prune — it
--   probes each partition's index. That is a few cheap btree descents, fine for
--   the point reads this app does, and the call sites that already hold a row
--   pass the composite key and prune properly. See src/lib/callLogKey.ts.
--
-- THIS MIGRATION REWRITES THE TABLE. On an empty or small table it is instant.
-- On a large one it holds an exclusive lock for the whole copy — run it in a
-- maintenance window, or follow the online, no-downtime variant in
-- docs/call-log-partitioning.md.
--
-- READ docs/call-log-partitioning.md FIRST. The deploy currently runs
-- `prisma db push --accept-data-loss`, which cannot see that this table must
-- stay partitioned; that has to change to `prisma migrate deploy` before this
-- reaches production.
--
-- A partitioned parent holds no rows itself, so the swap has to copy.

BEGIN;

-- 1. Rename the original out of the way.
--
--    Renaming a table does NOT rename the constraints and indexes attached to
--    it — they keep the old names and would collide with the new table's, which
--    Postgres reports as the distinctly unhelpful `relation "call_logs_pkey"
--    already exists`. So each one is renamed explicitly.
ALTER TABLE "call_logs" RENAME TO "call_logs_unpartitioned";

ALTER TABLE "call_logs_unpartitioned" RENAME CONSTRAINT "call_logs_pkey"
  TO "call_logs_unpartitioned_pkey";
ALTER TABLE "call_logs_unpartitioned" RENAME CONSTRAINT "call_logs_conversionId_fkey"
  TO "call_logs_unpartitioned_conversionId_fkey";
ALTER TABLE "call_logs_unpartitioned" RENAME CONSTRAINT "call_logs_brandId_fkey"
  TO "call_logs_unpartitioned_brandId_fkey";

-- IF EXISTS on the indexes: which of these are present depends on how far
-- through the 0054 index work a given database has got.
ALTER INDEX IF EXISTS "call_logs_publicId_key"
  RENAME TO "call_logs_unpartitioned_publicId_key";
-- A table created by `prisma db push` from the CURRENT schema already carries
-- the composite unique index under its final name, so it must move aside too —
-- or the CREATE below collides with it. No-op on a database that came up the
-- migrate path, where the index is still called "call_logs_publicId_key".
ALTER INDEX IF EXISTS "call_logs_publicId_createdAt_key"
  RENAME TO "call_logs_unpartitioned_publicId_createdAt_key";
ALTER INDEX IF EXISTS "call_logs_conversionId_createdAt_idx"
  RENAME TO "call_logs_unpartitioned_conversionId_createdAt_idx";
ALTER INDEX IF EXISTS "call_logs_conversionId_intent_idx"
  RENAME TO "call_logs_unpartitioned_conversionId_intent_idx";
ALTER INDEX IF EXISTS "call_logs_brandId_createdAt_idx"
  RENAME TO "call_logs_unpartitioned_brandId_createdAt_idx";
ALTER INDEX IF EXISTS "call_logs_createdAt_idx"
  RENAME TO "call_logs_unpartitioned_createdAt_idx";
ALTER INDEX IF EXISTS "call_logs_brandId_idx"
  RENAME TO "call_logs_unpartitioned_brandId_idx";

-- 2. The new parent. Column list mirrors the old table exactly; the partition
--    key must be NOT NULL, which createdAt already is.
CREATE TABLE "call_logs" (
    "id"                       TEXT         NOT NULL,
    "conversionId"             TEXT         NOT NULL,
    "brandId"                  TEXT,
    "type"                     "CallType"    NOT NULL DEFAULT 'Web',
    "callerName"               TEXT         NOT NULL DEFAULT 'Unknown',
    "callerNumber"             TEXT         NOT NULL DEFAULT '',
    "durationSec"              INTEGER      NOT NULL DEFAULT 0,
    "outcome"                  "CallOutcome" NOT NULL DEFAULT 'completed',
    "summary"                  TEXT         NOT NULL DEFAULT '',
    "purpose"                  TEXT         NOT NULL DEFAULT '',
    "intent"                   TEXT         NOT NULL DEFAULT '',
    "intentSource"             TEXT         NOT NULL DEFAULT 'ai',
    "requestedDepartment"      TEXT         NOT NULL DEFAULT '',
    "transferOutcome"          TEXT         NOT NULL DEFAULT '',
    "recordingUrl"             TEXT,
    "vapiCallId"               TEXT,
    "transcript"               JSONB        NOT NULL DEFAULT '[]',
    "analysis"                 JSONB        NOT NULL DEFAULT '{}',
    "transcriptTranslated"     JSONB,
    "transcriptTranslatedLang" TEXT,
    "summaryTranslated"        TEXT,
    "publicId"                 TEXT,
    "shareExpiresAt"           TIMESTAMP(3),
    "blobKey"                  TEXT,
    "blobArchivedAt"           TIMESTAMP(3),
    "createdAt"                TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "call_logs_pkey" PRIMARY KEY ("id", "createdAt")
) PARTITION BY RANGE ("createdAt");

-- 3. A catch-all for anything outside the months we create. Without it an
--    insert with an unexpected timestamp fails outright, which would mean
--    dropping a real call because a maintenance job was late. The sweep in
--    services/callPartitions.ts keeps months provisioned ahead of time, so this
--    should stay empty — it being non-empty is the alarm that it didn't run.
CREATE TABLE "call_logs_default" PARTITION OF "call_logs" DEFAULT;

-- 4. Copy the history across. Partition routing happens on insert, so rows land
--    in the default partition here; `npm run repartition-calls` redistributes
--    them into monthly partitions afterwards.
--    Columns are named on both sides rather than relying on ordinal position:
--    the old table's column order is the order features were added in, not the
--    order below, and a positional INSERT would silently transpose values of
--    the same type.
INSERT INTO "call_logs" (
    "id", "conversionId", "brandId", "type", "callerName", "callerNumber",
    "durationSec", "outcome", "summary", "purpose", "intent", "intentSource",
    "requestedDepartment", "transferOutcome", "recordingUrl", "vapiCallId",
    "transcript", "analysis", "transcriptTranslated", "transcriptTranslatedLang",
    "summaryTranslated", "publicId", "shareExpiresAt", "blobKey",
    "blobArchivedAt", "createdAt"
)
SELECT
    "id", "conversionId", "brandId", "type", "callerName", "callerNumber",
    "durationSec", "outcome", "summary", "purpose", "intent", "intentSource",
    "requestedDepartment", "transferOutcome", "recordingUrl", "vapiCallId",
    "transcript", "analysis", "transcriptTranslated", "transcriptTranslatedLang",
    "summaryTranslated", "publicId", "shareExpiresAt", "blobKey",
    "blobArchivedAt", "createdAt"
FROM "call_logs_unpartitioned";

-- 5. Indexes. On a partitioned parent these are templates: Postgres creates and
--    maintains a matching index on every existing and future partition.
CREATE UNIQUE INDEX "call_logs_publicId_createdAt_key" ON "call_logs" ("publicId", "createdAt");
CREATE INDEX "call_logs_conversionId_createdAt_idx"    ON "call_logs" ("conversionId", "createdAt");
CREATE INDEX "call_logs_conversionId_intent_idx"       ON "call_logs" ("conversionId", "intent");
CREATE INDEX "call_logs_brandId_createdAt_idx"         ON "call_logs" ("brandId", "createdAt");
CREATE INDEX "call_logs_createdAt_idx"                 ON "call_logs" ("createdAt");

-- 6. Foreign keys. Supported FROM a partitioned table since PG12, and cascaded
--    to each partition automatically. Nothing references call_logs, so there is
--    no inbound FK to worry about — which is the reason this table can be
--    partitioned at all without touching the rest of the schema.
ALTER TABLE "call_logs"
    ADD CONSTRAINT "call_logs_conversionId_fkey"
    FOREIGN KEY ("conversionId") REFERENCES "conversions"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "call_logs"
    ADD CONSTRAINT "call_logs_brandId_fkey"
    FOREIGN KEY ("brandId") REFERENCES "brands"("id") ON DELETE SET NULL ON UPDATE CASCADE;

COMMIT;

-- 7. Verify the copy before you lose the original. Run this, confirm the two
--    counts match, and only then drop:
--
--     SELECT (SELECT count(*) FROM "call_logs") AS new,
--            (SELECT count(*) FROM "call_logs_unpartitioned") AS old;
--
--     DROP TABLE "call_logs_unpartitioned";
--
-- Left in place on purpose: an automatic DROP here would make a botched copy
-- unrecoverable, and this is the one step in the whole plan that cannot be
-- undone.
