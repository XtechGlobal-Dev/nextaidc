-- Phase 5: platform views (docs/tenant-db-expansion-plan.md).
--
-- Main keeps only what the super admin's own screens need without opening a
-- tenant: last night's numbers per brand and a thin customer directory. The
-- audit log records which plane its actor lives in.

-- 1. Audit actors may live in a tenant.
ALTER TABLE "audit_logs" ADD COLUMN "actorBrandId" TEXT;
CREATE INDEX "audit_logs_actorBrandId_createdAt_idx" ON "audit_logs"("actorBrandId", "createdAt");

-- Every entry so far was recorded while accounts were still in Main, so the
-- actor's brand is still knowable here — stamp it once, now, before phase 6
-- takes those rows away.
UPDATE "audit_logs" a
SET "actorBrandId" = u."brandId"
FROM "users" u
WHERE u."id" = a."actorId" AND a."actorBrandId" IS NULL AND u."brandId" IS NOT NULL;

-- 2. Nightly rollup, one row per brand per day.
CREATE TABLE "brand_stats_daily" (
    "brandId" TEXT NOT NULL,
    "day" DATE NOT NULL,
    "customers" INTEGER NOT NULL DEFAULT 0,
    "active" INTEGER NOT NULL DEFAULT 0,
    "trialing" INTEGER NOT NULL DEFAULT 0,
    "callsTotal" INTEGER NOT NULL DEFAULT 0,
    "minutesTotal" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "openTickets" INTEGER NOT NULL DEFAULT 0,
    "calls" INTEGER NOT NULL DEFAULT 0,
    "minutes" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "computedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "brand_stats_daily_pkey" PRIMARY KEY ("brandId","day")
);
CREATE INDEX "brand_stats_daily_day_idx" ON "brand_stats_daily"("day");
ALTER TABLE "brand_stats_daily" ADD CONSTRAINT "brand_stats_daily_brandId_fkey"
  FOREIGN KEY ("brandId") REFERENCES "brands"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- 3. Thin customer directory.
CREATE TABLE "customer_directory" (
    "brandId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "fullName" TEXT NOT NULL DEFAULT '',
    "role" "Role" NOT NULL DEFAULT 'USER',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "customer_directory_pkey" PRIMARY KEY ("brandId","userId")
);
CREATE INDEX "customer_directory_email_idx" ON "customer_directory"("email");
CREATE INDEX "customer_directory_brandId_role_idx" ON "customer_directory"("brandId", "role");
ALTER TABLE "customer_directory" ADD CONSTRAINT "customer_directory_brandId_fkey"
  FOREIGN KEY ("brandId") REFERENCES "brands"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Seed it from the accounts Main still holds (they are mirrored into the
-- tenants until phase 6; from then on the tenant write sites keep this current).
INSERT INTO "customer_directory" ("brandId", "userId", "email", "fullName", "role", "createdAt", "updatedAt")
SELECT u."brandId", u."id", u."email", u."fullName", u."role", u."createdAt", CURRENT_TIMESTAMP
FROM "users" u
WHERE u."brandId" IS NOT NULL
ON CONFLICT ("brandId", "userId") DO NOTHING;
