-- CreateTable
CREATE TABLE "stripe_customers" (
    "stripeCustomerId" TEXT NOT NULL,
    "brandId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "stripe_customers_pkey" PRIMARY KEY ("stripeCustomerId")
);

-- CreateTable
CREATE TABLE "platform_ledger" (
    "id" TEXT NOT NULL,
    "stripeInvoiceId" TEXT NOT NULL,
    "stripeCustomerId" TEXT NOT NULL,
    "brandId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "planId" TEXT,
    "couponId" TEXT,
    "currency" TEXT NOT NULL DEFAULT 'usd',
    "totalCents" INTEGER NOT NULL,
    "platformCents" INTEGER NOT NULL,
    "brandCents" INTEGER NOT NULL,
    "refundedCents" INTEGER NOT NULL DEFAULT 0,
    "periodStart" TIMESTAMP(3),
    "periodEnd" TIMESTAMP(3),
    "source" TEXT NOT NULL DEFAULT 'webhook',
    "paidAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "platform_ledger_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stripe_unrouted_events" (
    "id" TEXT NOT NULL,
    "stripeEventId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "stripeCustomerId" TEXT,
    "stripeSubscriptionId" TEXT,
    "payload" JSONB NOT NULL,
    "reason" TEXT NOT NULL DEFAULT '',
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),
    "resolution" TEXT,
    "resolvedById" TEXT,

    CONSTRAINT "stripe_unrouted_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "stripe_customers_brandId_idx" ON "stripe_customers"("brandId");

-- CreateIndex
CREATE INDEX "stripe_customers_userId_idx" ON "stripe_customers"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "platform_ledger_stripeInvoiceId_key" ON "platform_ledger"("stripeInvoiceId");

-- CreateIndex
CREATE INDEX "platform_ledger_brandId_paidAt_idx" ON "platform_ledger"("brandId", "paidAt");

-- CreateIndex
CREATE INDEX "platform_ledger_paidAt_idx" ON "platform_ledger"("paidAt");

-- CreateIndex
CREATE UNIQUE INDEX "stripe_unrouted_events_stripeEventId_key" ON "stripe_unrouted_events"("stripeEventId");

-- CreateIndex
CREATE INDEX "stripe_unrouted_events_resolvedAt_receivedAt_idx" ON "stripe_unrouted_events"("resolvedAt", "receivedAt");

