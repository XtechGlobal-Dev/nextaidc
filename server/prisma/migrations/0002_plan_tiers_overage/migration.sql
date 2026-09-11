-- AlterTable: add overage pricing, sort order, and recommended flag to plans
ALTER TABLE "subscription_plans" ADD COLUMN "overagePerMinuteCents" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "subscription_plans" ADD COLUMN "sortOrder" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "subscription_plans" ADD COLUMN "recommended" BOOLEAN NOT NULL DEFAULT false;
