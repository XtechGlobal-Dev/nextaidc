-- CreateTable
CREATE TABLE "plan_events" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "fromPlanId" TEXT,
    "fromPlanName" TEXT,
    "toPlanId" TEXT,
    "toPlanName" TEXT,
    "priceCents" INTEGER NOT NULL DEFAULT 0,
    "currency" TEXT NOT NULL DEFAULT 'usd',
    "amountCents" INTEGER NOT NULL DEFAULT 0,
    "note" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "plan_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "plan_events_userId_createdAt_idx" ON "plan_events"("userId", "createdAt");

