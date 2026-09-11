-- Tenant lifecycle: every brand gets its own database from the moment it is
-- created, and keeps it for 30 days after it is deleted.
--
-- BrandStatus gains the two states a brand passes through before it is live:
--   provisioning — row created, its database is being set up; the door is shut
--   failed       — setup broke (brand_databases.error says how); Retry re-runs it
-- Only `active` resolves a front door (middleware/brand.ts), so neither state
-- can take a login or a sign-up.
ALTER TYPE "BrandStatus" ADD VALUE IF NOT EXISTS 'provisioning';
ALTER TYPE "BrandStatus" ADD VALUE IF NOT EXISTS 'failed';

-- Where a tenant's database actually is. `neon`: its own Neon project (the
-- production shape — isolation, its own region). `local-schema`: a Postgres
-- schema on the platform's own database, used when NEON_API_KEY is not set
-- (development, tests) so the same code path runs everywhere.
ALTER TABLE "brand_databases"
    ADD COLUMN "provider"   TEXT NOT NULL DEFAULT 'neon',
    ADD COLUMN "schemaName" TEXT NOT NULL DEFAULT '';

-- A deleted brand's database outlives the brand by 30 days, so a mistaken
-- delete is recoverable. The brand row (and its brand_databases row) is gone by
-- then, so what the sweep needs to find and remove the database is copied here.
CREATE TABLE "tenant_database_retirements" (
    "id"            TEXT NOT NULL,
    "brandSlug"     TEXT NOT NULL,
    "brandName"     TEXT NOT NULL,
    "provider"      TEXT NOT NULL,
    "neonProjectId" TEXT NOT NULL DEFAULT '',
    "schemaName"    TEXT NOT NULL DEFAULT '',
    "region"        TEXT NOT NULL DEFAULT '',
    "retireAfter"   TIMESTAMP(3) NOT NULL,
    "createdAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tenant_database_retirements_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "tenant_database_retirements_retireAfter_idx"
    ON "tenant_database_retirements" ("retireAfter");
