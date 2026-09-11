-- Plan lifecycle history (Admin → Subscriptions). One row per subscription
-- event; plan names are denormalized so history survives plan rename/deletion.
-- Idempotent so it can be applied safely against the already-diverged DB
-- (see server/MIGRATIONS.md).
CREATE TABLE IF NOT EXISTS "plan_events" (
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

CREATE INDEX IF NOT EXISTS "plan_events_userId_createdAt_idx" ON "plan_events"("userId", "createdAt");

DO $$ BEGIN
    ALTER TABLE "plan_events"
        ADD CONSTRAINT "plan_events_userId_fkey"
        FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;
