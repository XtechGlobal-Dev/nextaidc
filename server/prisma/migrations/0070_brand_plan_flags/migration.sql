-- Brand plans get the same two flags customer plans have: `recommended` (a
-- "Popular" badge on the request form) and `isDefault` (pre-selected there and in
-- the create wizard; at most one, kept so by the service).
--
-- Idempotent (see server/MIGRATIONS.md).

ALTER TABLE "brand_plans" ADD COLUMN IF NOT EXISTS "recommended" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "brand_plans" ADD COLUMN IF NOT EXISTS "isDefault"   BOOLEAN NOT NULL DEFAULT false;
