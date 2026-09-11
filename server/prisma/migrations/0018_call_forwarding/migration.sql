-- Call forwarding setup: which behaviour the owner chose ("" | "all" | "overflow")
-- and when they confirmed forwarding from their existing number to the AI number
-- is live. Self-reported; reuses businessNumber (from) and receptionistNumber (to).
ALTER TABLE "profiles" ADD COLUMN IF NOT EXISTS "forwardingMode" TEXT NOT NULL DEFAULT '';
ALTER TABLE "profiles" ADD COLUMN IF NOT EXISTS "forwardingConfirmedAt" TIMESTAMP(3);
