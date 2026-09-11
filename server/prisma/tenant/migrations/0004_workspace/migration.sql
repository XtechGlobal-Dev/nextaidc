-- CreateEnum
CREATE TYPE "Plan" AS ENUM ('free', 'premium');

-- CreateEnum
CREATE TYPE "VerificationPurpose" AS ENUM ('signup', 'password_reset', 'impersonation_pin_reset');

-- CreateTable
CREATE TABLE "profiles" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "businessName" TEXT NOT NULL DEFAULT '',
    "mobile" TEXT NOT NULL DEFAULT '',
    "website" TEXT NOT NULL DEFAULT '',
    "businessNumber" TEXT NOT NULL DEFAULT '',
    "address" TEXT NOT NULL DEFAULT '',
    "country" TEXT NOT NULL DEFAULT '',
    "timezone" TEXT NOT NULL DEFAULT '',
    "industry" TEXT NOT NULL DEFAULT '',
    "plan" "Plan" NOT NULL DEFAULT 'free',
    "testMinutesUsed" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "webTestMinutesUsed" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "webTestCycleStart" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "receptionistNumber" TEXT NOT NULL DEFAULT '',
    "numberActivated" BOOLEAN NOT NULL DEFAULT false,
    "forwardingMode" TEXT NOT NULL DEFAULT '',
    "forwardingConfirmedAt" TIMESTAMP(3),
    "onboardingStep" INTEGER NOT NULL DEFAULT 0,
    "onboardingCompletedAt" TIMESTAMP(3),
    "quickSetupSeenAt" TIMESTAMP(3),
    "subscriptionPlanId" TEXT,
    "stripeCustomerId" TEXT,
    "stripeSubscriptionId" TEXT,
    "subscriptionStatus" TEXT NOT NULL DEFAULT 'none',
    "cardRequiredAtSignup" BOOLEAN NOT NULL DEFAULT false,
    "cardConfirmedAt" TIMESTAMP(3),
    "suspendedAt" TIMESTAMP(3),
    "autoRenew" BOOLEAN NOT NULL DEFAULT true,
    "trialEndsAt" TIMESTAMP(3),
    "cardFingerprint" TEXT,
    "trialStartedAt" TIMESTAMP(3),
    "trialMinutesAllocated" DOUBLE PRECISION,
    "trialSecondsUsed" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "trialStatus" TEXT NOT NULL DEFAULT 'active',
    "planMinutesAllocated" DOUBLE PRECISION,
    "planSecondsUsed" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "currentPeriodEnd" TIMESTAMP(3),
    "usageAlertsSent" TEXT NOT NULL DEFAULT '',
    "graceStartedAt" TIMESTAMP(3),
    "graceEndsAt" TIMESTAMP(3),
    "graceNotifyStage" TEXT,
    "graceConsumedAt" TIMESTAMP(3),
    "scheduledPlanId" TEXT,
    "scheduledPlanEffectiveAt" TIMESTAMP(3),
    "stripeScheduleId" TEXT,
    "pendingSwitchCustomerId" TEXT,
    "pendingSwitchSubscriptionId" TEXT,
    "pendingSwitchPlanId" TEXT,
    "pendingSwitchStartedAt" TIMESTAMP(3),
    "activeCouponRedemptionId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "profiles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "conversions" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "agentConfig" JSONB NOT NULL,
    "dataCaptureFields" JSONB NOT NULL DEFAULT '[]',
    "promptTemplateSnapshot" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "approvedAt" TIMESTAMP(3),
    "vapiAssistantId" TEXT,
    "vapiSyncPendingAt" TIMESTAMP(3),
    "vapiSyncNextAt" TIMESTAMP(3),
    "vapiSyncAttempts" INTEGER NOT NULL DEFAULT 0,
    "vapiSyncError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "conversions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "crm_integrations" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "connectedProvider" TEXT,
    "googleCalendarConnected" BOOLEAN NOT NULL DEFAULT false,
    "customWebhookUrl" TEXT NOT NULL DEFAULT '',
    "perfexUrl" TEXT,
    "perfexFormKey" TEXT,
    "bookingEnabled" BOOLEAN NOT NULL DEFAULT false,
    "bookingDurationMin" INTEGER NOT NULL DEFAULT 30,
    "bookingCalendarId" TEXT NOT NULL DEFAULT 'primary',
    "bookingTimezone" TEXT NOT NULL DEFAULT '',
    "bookingLinkEnabled" BOOLEAN NOT NULL DEFAULT false,
    "bookingUrl" TEXT NOT NULL DEFAULT '',
    "bookingLabel" TEXT NOT NULL DEFAULT 'appointment',
    "bookingFields" TEXT NOT NULL DEFAULT '',
    "bookingHours" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "crm_integrations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "webhook_deliveries" (
    "id" TEXT NOT NULL,
    "crmIntegrationId" TEXT,
    "callLogId" TEXT,
    "provider" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "status" INTEGER NOT NULL,
    "success" BOOLEAN NOT NULL,
    "payload" JSONB NOT NULL,
    "responseBody" TEXT NOT NULL DEFAULT '',
    "errorMessage" TEXT NOT NULL DEFAULT '',
    "durationMs" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "webhook_deliveries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "human_transfer_settings" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "transferNumber" TEXT NOT NULL DEFAULT '',
    "ringTimeoutSec" INTEGER NOT NULL DEFAULT 25,
    "fallbackMessage" TEXT NOT NULL DEFAULT 'Our support team isn''t available right now. We''ve recorded your request and will contact you as soon as possible. Thank you for calling.',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "human_transfer_settings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "transfer_departments" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "number" TEXT NOT NULL DEFAULT '',
    "description" TEXT NOT NULL DEFAULT '',
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "ringTimeoutSec" INTEGER NOT NULL DEFAULT 15,
    "fallbackMessage" TEXT NOT NULL DEFAULT 'Our team isn''t available right now. We''ve recorded your request and will contact you as soon as possible. Thank you for calling.',
    "order" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "transfer_departments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "booking_appointments" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "customerName" TEXT NOT NULL DEFAULT '',
    "customerPhone" TEXT NOT NULL DEFAULT '',
    "customerEmail" TEXT NOT NULL DEFAULT '',
    "notes" TEXT NOT NULL DEFAULT '',
    "startAt" TIMESTAMP(3) NOT NULL,
    "endAt" TIMESTAMP(3) NOT NULL,
    "timezone" TEXT NOT NULL DEFAULT '',
    "status" TEXT NOT NULL DEFAULT 'confirmed',
    "source" TEXT NOT NULL DEFAULT 'ai',
    "googleEventId" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "booking_appointments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "chat_conversations" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "humanTakeover" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "chat_conversations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "chat_messages" (
    "id" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "chat_messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "verification_codes" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "purpose" "VerificationPurpose" NOT NULL,
    "codeHash" TEXT NOT NULL,
    "payload" JSONB,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "verification_codes_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "profiles_userId_key" ON "profiles"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "profiles_cardFingerprint_key" ON "profiles"("cardFingerprint");

-- CreateIndex
CREATE INDEX "profiles_createdAt_idx" ON "profiles"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "conversions_userId_key" ON "conversions"("userId");

-- CreateIndex
CREATE INDEX "conversions_vapiSyncNextAt_idx" ON "conversions"("vapiSyncNextAt");

-- CreateIndex
CREATE UNIQUE INDEX "crm_integrations_userId_key" ON "crm_integrations"("userId");

-- CreateIndex
CREATE INDEX "webhook_deliveries_crmIntegrationId_createdAt_idx" ON "webhook_deliveries"("crmIntegrationId", "createdAt");

-- CreateIndex
CREATE INDEX "webhook_deliveries_createdAt_idx" ON "webhook_deliveries"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "human_transfer_settings_userId_key" ON "human_transfer_settings"("userId");

-- CreateIndex
CREATE INDEX "transfer_departments_userId_idx" ON "transfer_departments"("userId");

-- CreateIndex
CREATE INDEX "booking_appointments_userId_startAt_idx" ON "booking_appointments"("userId", "startAt");

-- CreateIndex
CREATE INDEX "chat_conversations_userId_idx" ON "chat_conversations"("userId");

-- CreateIndex
CREATE INDEX "chat_messages_conversationId_createdAt_idx" ON "chat_messages"("conversationId", "createdAt");

-- CreateIndex
CREATE INDEX "verification_codes_email_purpose_idx" ON "verification_codes"("email", "purpose");

-- AddForeignKey
ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_crmIntegrationId_fkey" FOREIGN KEY ("crmIntegrationId") REFERENCES "crm_integrations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chat_messages" ADD CONSTRAINT "chat_messages_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "chat_conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

