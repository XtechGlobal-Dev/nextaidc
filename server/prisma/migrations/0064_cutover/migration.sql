-- Phase 6 cutover (docs/tenant-db-expansion-plan.md): Main keeps the
-- platform's own things. Every table that hung off a brand account — profiles,
-- agent records, calls, the customer workspace, billing history, coupon
-- redemptions, commissions — now exists only in the brand's database, and the
-- accounts themselves are there too. Rows here were mirrors or dev data; per
-- the plan they are dropped, not copied.

-- The pre-partition copy of the call table and the old detail table, if either
-- is still around, hold keys into tables dropped below: they go first.
DROP TABLE IF EXISTS "call_logs_unpartitioned";
DROP TABLE IF EXISTS "call_details";

-- DropForeignKey
ALTER TABLE "users" DROP CONSTRAINT "users_brandId_fkey";

-- DropForeignKey
ALTER TABLE "human_transfer_settings" DROP CONSTRAINT "human_transfer_settings_userId_fkey";

-- DropForeignKey
ALTER TABLE "transfer_departments" DROP CONSTRAINT "transfer_departments_userId_fkey";

-- DropForeignKey
ALTER TABLE "profiles" DROP CONSTRAINT "profiles_userId_fkey";

-- DropForeignKey
ALTER TABLE "profiles" DROP CONSTRAINT "profiles_brandId_fkey";

-- DropForeignKey
ALTER TABLE "profiles" DROP CONSTRAINT "profiles_subscriptionPlanId_fkey";

-- DropForeignKey
ALTER TABLE "conversions" DROP CONSTRAINT "conversions_userId_fkey";

-- DropForeignKey
ALTER TABLE "call_logs" DROP CONSTRAINT "call_logs_conversionId_fkey";

-- DropForeignKey
ALTER TABLE "call_logs" DROP CONSTRAINT "call_logs_brandId_fkey";

-- DropForeignKey
ALTER TABLE "crm_integrations" DROP CONSTRAINT "crm_integrations_userId_fkey";

-- DropForeignKey
ALTER TABLE "booking_appointments" DROP CONSTRAINT "booking_appointments_userId_fkey";

-- DropForeignKey
ALTER TABLE "webhook_deliveries" DROP CONSTRAINT "webhook_deliveries_crmIntegrationId_fkey";

-- DropForeignKey
ALTER TABLE "chat_conversations" DROP CONSTRAINT "chat_conversations_userId_fkey";

-- DropForeignKey
ALTER TABLE "phone_numbers" DROP CONSTRAINT "phone_numbers_userId_fkey";

-- DropForeignKey
ALTER TABLE "chat_messages" DROP CONSTRAINT "chat_messages_conversationId_fkey";

-- DropForeignKey
ALTER TABLE "coupon_redemptions" DROP CONSTRAINT "coupon_redemptions_couponId_fkey";

-- DropForeignKey
ALTER TABLE "coupon_redemptions" DROP CONSTRAINT "coupon_redemptions_userId_fkey";

-- DropForeignKey
ALTER TABLE "commissions" DROP CONSTRAINT "commissions_resellerId_fkey";

-- DropForeignKey
ALTER TABLE "commissions" DROP CONSTRAINT "commissions_customerId_fkey";

-- DropForeignKey
ALTER TABLE "plan_events" DROP CONSTRAINT "plan_events_userId_fkey";

-- DropForeignKey
ALTER TABLE "brand_members" DROP CONSTRAINT "brand_members_brandId_fkey";

-- DropForeignKey
ALTER TABLE "brand_members" DROP CONSTRAINT "brand_members_userId_fkey";

-- DropForeignKey
ALTER TABLE "tickets" DROP CONSTRAINT "tickets_requesterId_fkey";

-- DropIndex
DROP INDEX "users_brandId_createdAt_idx";

-- Every brand account is in its brand's own database (mirrored there since
-- phase 1, written there from now on). Main keeps only the platform's own
-- people. The foreign keys above are gone, so nothing cascades from this.
DELETE FROM "users" WHERE "brandId" IS NOT NULL;

-- The rule "every account has a brand unless it is the platform's" (migration
-- 0057) is now enforced by which database an account is in.
ALTER TABLE "users" DROP CONSTRAINT IF EXISTS "users_brand_required_unless_platform";

-- AlterTable
ALTER TABLE "users" DROP COLUMN "brandId";

-- DropTable
DROP TABLE "human_transfer_settings";

-- DropTable
DROP TABLE "transfer_departments";

-- DropTable
DROP TABLE "profiles";

-- DropTable
DROP TABLE "conversions";

-- DropTable (the partitioned parent takes its monthly partitions with it; the
-- pre-partition copy and the old detail table, if either is still around, go too)
DROP TABLE "call_logs";

-- DropTable
DROP TABLE "crm_integrations";

-- DropTable
DROP TABLE "booking_appointments";

-- DropTable
DROP TABLE "webhook_deliveries";

-- DropTable
DROP TABLE "chat_conversations";

-- DropTable
DROP TABLE "chat_messages";

-- DropTable
DROP TABLE "coupon_redemptions";

-- DropTable
DROP TABLE "commissions";

-- DropTable
DROP TABLE "plan_events";

-- DropTable
DROP TABLE "brand_members";

-- CreateIndex
CREATE INDEX "customer_directory_userId_idx" ON "customer_directory"("userId");

