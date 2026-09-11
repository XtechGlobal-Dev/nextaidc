-- Explicit brand membership, plus direct brand links on the two biggest
-- per-tenant tables.
--
-- `brand_members` is the authoritative record of who belongs to which tenant.
-- `users.brandId` (added in 0045) stays as a denormalised mirror of it: tenant
-- scoping runs on every admin read path, and a join there would cost more than
-- a column — the same trade-off `users.permissions` already makes against
-- staff_roles. Both are written together by setBrandMembership().
--
-- `userId` is UNIQUE, so a person belongs to at most one brand. That is the
-- rule the whole tenancy model rests on: a customer in two tenants at once
-- would make "whose customer is this?" unanswerable.
--
-- profiles.brandId / call_logs.brandId are denormalised off the owner so
-- "everything for brand X" is one indexed read instead of a three-hop join
-- (call -> conversion -> user -> brand) on the largest table in the schema.
--
-- Backfilled from users.brandId below, so existing tenants are complete the
-- moment this runs. Idempotent (see server/MIGRATIONS.md).

CREATE TABLE IF NOT EXISTS "brand_members" (
  "brandId"   TEXT         NOT NULL,
  "userId"    TEXT         NOT NULL,
  "addedById" TEXT,
  "joinedAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "brand_members_pkey" PRIMARY KEY ("brandId", "userId")
);

-- One brand per person.
CREATE UNIQUE INDEX IF NOT EXISTS "brand_members_userId_key" ON "brand_members" ("userId");
CREATE INDEX IF NOT EXISTS "brand_members_brandId_idx" ON "brand_members" ("brandId");

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'brand_members_brandId_fkey') THEN
    ALTER TABLE "brand_members"
      ADD CONSTRAINT "brand_members_brandId_fkey"
      FOREIGN KEY ("brandId") REFERENCES "brands"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'brand_members_userId_fkey') THEN
    ALTER TABLE "brand_members"
      ADD CONSTRAINT "brand_members_userId_fkey"
      FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END
$$;

-- Direct brand links on the per-tenant data tables.
ALTER TABLE "profiles"  ADD COLUMN IF NOT EXISTS "brandId" TEXT;
ALTER TABLE "call_logs" ADD COLUMN IF NOT EXISTS "brandId" TEXT;

CREATE INDEX IF NOT EXISTS "profiles_brandId_idx"  ON "profiles"  ("brandId");
CREATE INDEX IF NOT EXISTS "call_logs_brandId_idx" ON "call_logs" ("brandId");

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'profiles_brandId_fkey') THEN
    ALTER TABLE "profiles"
      ADD CONSTRAINT "profiles_brandId_fkey"
      FOREIGN KEY ("brandId") REFERENCES "brands"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'call_logs_brandId_fkey') THEN
    ALTER TABLE "call_logs"
      ADD CONSTRAINT "call_logs_brandId_fkey"
      FOREIGN KEY ("brandId") REFERENCES "brands"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END
$$;

-- Backfill from the tenant column 0045 introduced. ON CONFLICT so a re-run is a
-- no-op rather than a duplicate-key failure.
INSERT INTO "brand_members" ("brandId", "userId", "addedById", "joinedAt")
SELECT u."brandId", u."id", NULL, u."createdAt"
FROM "users" u
WHERE u."brandId" IS NOT NULL
ON CONFLICT DO NOTHING;

UPDATE "profiles" p
SET "brandId" = u."brandId"
FROM "users" u
WHERE u."id" = p."userId"
  AND p."brandId" IS DISTINCT FROM u."brandId";

UPDATE "call_logs" c
SET "brandId" = u."brandId"
FROM "conversions" cv
JOIN "users" u ON u."id" = cv."userId"
WHERE cv."id" = c."conversionId"
  AND c."brandId" IS DISTINCT FROM u."brandId";
