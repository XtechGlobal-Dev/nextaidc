-- Brand deactivation: a super admin switches a brand off with a 30-day
-- countdown. The daily sweep deletes the brand (row and database) once the
-- countdown ends; reactivating clears it. Deleting a brand outright now drops
-- its database immediately instead of queuing it in tenant_database_retirements.
ALTER TYPE "BrandStatus" ADD VALUE IF NOT EXISTS 'deactivated';
ALTER TABLE "brands" ADD COLUMN "deactivatedAt" TIMESTAMP(3);
