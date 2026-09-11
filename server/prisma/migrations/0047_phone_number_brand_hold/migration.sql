-- Tenant-scoped phone numbers, plus the post-release hold window.
--
-- Two columns on phone_numbers:
--
--   brandId    Which tenant holds the number. Denormalised off the owner exactly
--              like profiles.brandId / call_logs.brandId (0046), but here it is
--              load-bearing rather than an optimisation: releasing a number nulls
--              userId, and with it every trace of whose customer had it. Without
--              a stored brand there is nothing to hold the number against.
--
--   releasedAt When a number was DELIBERATELY given up (brand admin moved it to
--              the pool, or the customer released it). Null for everything else.
--
-- Together with poolStatus = 'HELD' and the phones.releaseHoldDays platform
-- setting these drive the cooldown: until releasedAt + holdDays the number sits
-- in the releasing brand's pool, visible but unassignable; after that the hourly
-- sweep clears both columns and returns it to the shared platform pool.
--
-- 'HELD' is a new poolStatus value, not a new column. Every allocation path
-- already filters on poolStatus = 'AVAILABLE' (signup, provisioning, replenish
-- accounting, admin auto-assign), so a held number is frozen everywhere by
-- construction instead of by each caller remembering to check. poolStatus is a
-- plain TEXT column, so no enum change is needed.
--
-- Backfilled from the current owner below, so numbers already assigned to a
-- tenant's customer land in the right pool the moment this runs. Idempotent
-- (see server/MIGRATIONS.md).

ALTER TABLE "phone_numbers"
  ADD COLUMN IF NOT EXISTS "brandId" TEXT;

ALTER TABLE "phone_numbers"
  ADD COLUMN IF NOT EXISTS "releasedAt" TIMESTAMP(3);

-- SetNull, matching users.brandId / profiles.brandId: deleting a brand must
-- never block, and a number outliving its tenant simply returns to the shared
-- platform pool rather than dangling against a brand that no longer exists.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'phone_numbers_brandId_fkey'
  ) THEN
    ALTER TABLE "phone_numbers"
      ADD CONSTRAINT "phone_numbers_brandId_fkey"
      FOREIGN KEY ("brandId") REFERENCES "brands"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

-- Drives every tenant-scoped pool read and the sweep's "which holds expired".
CREATE INDEX IF NOT EXISTS "phone_numbers_brandId_poolStatus_idx"
  ON "phone_numbers" ("brandId", "poolStatus");

-- Backfill: an assigned number belongs to its owner's tenant. Numbers held by a
-- platform-direct customer (users.brandId IS NULL) correctly stay NULL — the
-- shared pool is where they return to.
UPDATE "phone_numbers" pn
   SET "brandId" = u."brandId"
  FROM "users" u
 WHERE pn."userId" = u."id"
   AND u."brandId" IS NOT NULL
   AND pn."brandId" IS NULL;
