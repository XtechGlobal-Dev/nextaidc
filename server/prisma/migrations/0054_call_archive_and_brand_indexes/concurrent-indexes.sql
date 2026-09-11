-- Zero-downtime version of the index changes in migration.sql.
--
-- RUN THIS BY HAND, AGAINST THE DIRECT (UNPOOLED) CONNECTION, BEFORE DEPLOYING.
--
-- Why it lives outside the migration: CREATE INDEX takes an ACCESS EXCLUSIVE
-- lock for as long as the build runs, which on a call_logs table of any real
-- size means every call the platform tries to log during that window blocks.
-- CONCURRENTLY avoids the lock, but cannot run inside a transaction — and both
-- `prisma migrate` and `prisma db push` wrap their work in one. So the safe
-- version has to be run separately.
--
-- Run each statement on its own (they cannot be batched into a transaction):
--
--   psql "$DIRECT_URL" -f concurrent-indexes.sql
--
-- Afterwards the deploy's own CREATE INDEX IF NOT EXISTS statements find the
-- indexes already present and do nothing. Safe to re-run: a CONCURRENTLY build
-- that fails leaves an INVALID index behind, and the DROP ... IF EXISTS lines
-- at the bottom of a second run clean that up before rebuilding.

CREATE INDEX CONCURRENTLY IF NOT EXISTS "call_logs_brandId_createdAt_idx"
  ON "call_logs" ("brandId", "createdAt");

CREATE INDEX CONCURRENTLY IF NOT EXISTS "call_logs_createdAt_idx"
  ON "call_logs" ("createdAt");

CREATE INDEX CONCURRENTLY IF NOT EXISTS "users_brandId_createdAt_idx"
  ON "users" ("brandId", "createdAt");

CREATE INDEX CONCURRENTLY IF NOT EXISTS "profiles_brandId_createdAt_idx"
  ON "profiles" ("brandId", "createdAt");

-- Only once the four above report as valid:
--   SELECT indexrelid::regclass, indisvalid FROM pg_index
--   WHERE indexrelid::regclass::text LIKE '%brandId_createdAt_idx';

DROP INDEX CONCURRENTLY IF EXISTS "call_logs_brandId_idx";
DROP INDEX CONCURRENTLY IF EXISTS "users_brandId_idx";
DROP INDEX CONCURRENTLY IF EXISTS "profiles_brandId_idx";
