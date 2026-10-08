-- Brand-as-customer (docs/brand-as-customer-plan.md), phases 4–5.
--
-- 1. A Brand Admin request is filed from inside a main-domain customer's own
--    dashboard, so it names that account (its customer-state brand row and the
--    owner) instead of carrying a password of its own. New status:
--    `awaiting_domain` — approved, waiting for the applicant's own domain to go
--    live before the account becomes the Brand Admin.
-- 2. `brands.poolSpare`: a ready-made customer database kept in reserve, so a
--    main-domain sign-up claims one instead of waiting for a fresh one.
--
-- Idempotent (see server/MIGRATIONS.md).

ALTER TABLE "brand_requests" ADD COLUMN IF NOT EXISTS "applicantBrandId" TEXT;
ALTER TABLE "brand_requests" ADD COLUMN IF NOT EXISTS "applicantUserId"  TEXT;
CREATE INDEX IF NOT EXISTS "brand_requests_applicantBrandId_status_idx"
  ON "brand_requests" ("applicantBrandId", "status");

ALTER TABLE "brands" ADD COLUMN IF NOT EXISTS "poolSpare" BOOLEAN NOT NULL DEFAULT false;
CREATE INDEX IF NOT EXISTS "brands_poolSpare_status_idx" ON "brands" ("poolSpare", "status");
