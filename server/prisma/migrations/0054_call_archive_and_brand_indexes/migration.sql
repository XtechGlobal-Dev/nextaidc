-- Call log tiering + brand-scoped index fixes.
--
-- Two changes that share one cause: `call_logs` is the largest table in the
-- schema, and both its size and its read plans had stopped scaling. See
-- server/src/services/callArchive.ts.
--
-- ON A LARGE DEPLOYMENT, RUN `concurrent-indexes.sql` (next to this file)
-- AGAINST THE DATABASE FIRST. The CREATE INDEX statements below take an ACCESS
-- EXCLUSIVE lock and will stall every write to these three tables while they
-- build. They cannot be made CONCURRENT here, because Prisma runs each
-- migration inside a transaction and CONCURRENTLY is not allowed in one. Once
-- the concurrent versions exist, the IF NOT EXISTS clauses below are no-ops.

-- 1. Cold-storage pointer. Non-null means this call's transcript/analysis blobs
--    were moved to S3 and the JSON columns emptied; reads rehydrate from it.
ALTER TABLE "call_logs" ADD COLUMN IF NOT EXISTS "blobKey" TEXT;
ALTER TABLE "call_logs" ADD COLUMN IF NOT EXISTS "blobArchivedAt" TIMESTAMP(3);

-- 2. Vapi's call id, promoted out of the `analysis` JSON into its own column so
--    recording playback survives that blob being archived. Backfilled from the
--    existing JSON right here, so no row loses playback at deploy time —
--    `vapiCallIdOf()` also falls back to the JSON for anything this misses.
ALTER TABLE "call_logs" ADD COLUMN IF NOT EXISTS "vapiCallId" TEXT;

UPDATE "call_logs"
SET "vapiCallId" = "analysis" ->> 'vapiCallId'
WHERE "vapiCallId" IS NULL
  AND jsonb_typeof("analysis") = 'object'
  AND "analysis" ->> 'vapiCallId' IS NOT NULL;

-- 3. Brand-scoped listings are always "newest first". A bare brandId index made
--    Postgres match every row for the brand and then sort the lot. The
--    composite serves the plain equality lookups too (leftmost prefix), so the
--    old one is replaced rather than kept — a redundant index is pure write
--    cost on the busiest tables in the schema.
CREATE INDEX IF NOT EXISTS "call_logs_brandId_createdAt_idx"
  ON "call_logs" ("brandId", "createdAt");
CREATE INDEX IF NOT EXISTS "users_brandId_createdAt_idx"
  ON "users" ("brandId", "createdAt");
CREATE INDEX IF NOT EXISTS "profiles_brandId_createdAt_idx"
  ON "profiles" ("brandId", "createdAt");

-- 4. Drives the nightly archive and retention sweeps, which scan purely by age.
CREATE INDEX IF NOT EXISTS "call_logs_createdAt_idx"
  ON "call_logs" ("createdAt");

-- Dropped only after their replacements exist, so no query is ever momentarily
-- left without an index to use.
DROP INDEX IF EXISTS "call_logs_brandId_idx";
DROP INDEX IF EXISTS "users_brandId_idx";
DROP INDEX IF EXISTS "profiles_brandId_idx";
