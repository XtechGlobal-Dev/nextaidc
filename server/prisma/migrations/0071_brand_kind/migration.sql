-- Brand-as-customer (docs/brand-as-customer-plan.md, phase 1).
--
-- A brand row now also stands for a main-domain customer (kind = customer): its
-- own row and database, but no door of its own. Approval flips it to `brand`, a
-- downgrade flips it back. Every existing row is an approved brand.
--
-- ownerUserId is backfilled from the directory: the brand's oldest ADMIN.
--
-- Idempotent (see server/MIGRATIONS.md).

DO $$ BEGIN
  CREATE TYPE "BrandKind" AS ENUM ('customer', 'brand');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

ALTER TABLE "brands" ADD COLUMN IF NOT EXISTS "kind"            "BrandKind" NOT NULL DEFAULT 'brand';
ALTER TABLE "brands" ADD COLUMN IF NOT EXISTS "ownerUserId"     TEXT;
ALTER TABLE "brands" ADD COLUMN IF NOT EXISTS "activatedAt"     TIMESTAMP(3);
ALTER TABLE "brands" ADD COLUMN IF NOT EXISTS "brandSince"      TIMESTAMP(3);
ALTER TABLE "brands" ADD COLUMN IF NOT EXISTS "downgradedAt"    TIMESTAMP(3);
ALTER TABLE "brands" ADD COLUMN IF NOT EXISTS "statusWarnedFor" TEXT NOT NULL DEFAULT '';

-- Existing brands: approved as of their creation, active ever since.
UPDATE "brands" SET "brandSince" = "createdAt" WHERE "kind" = 'brand' AND "brandSince" IS NULL;
UPDATE "brands" SET "activatedAt" = "createdAt" WHERE "activatedAt" IS NULL AND "kind" = 'brand';

UPDATE "brands" b
SET "ownerUserId" = d."userId"
FROM (
  SELECT DISTINCT ON ("brandId") "brandId", "userId"
  FROM "customer_directory"
  WHERE "role" = 'ADMIN'
  ORDER BY "brandId", "createdAt" ASC
) d
WHERE d."brandId" = b."id" AND b."ownerUserId" IS NULL;

CREATE INDEX IF NOT EXISTS "brands_kind_idx" ON "brands" ("kind");
