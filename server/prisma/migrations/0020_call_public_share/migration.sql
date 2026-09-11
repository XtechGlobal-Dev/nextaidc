-- Short caller purpose/category shown in the summary SMS.
ALTER TABLE "call_logs" ADD COLUMN IF NOT EXISTS "purpose" TEXT NOT NULL DEFAULT '';

-- Public, unguessable slug + expiry for the "More info" conversation page linked
-- from the summary SMS. NULL publicId = no public page; NULL shareExpiresAt = never expires.
ALTER TABLE "call_logs" ADD COLUMN IF NOT EXISTS "publicId" TEXT;
ALTER TABLE "call_logs" ADD COLUMN IF NOT EXISTS "shareExpiresAt" TIMESTAMP(3);

CREATE UNIQUE INDEX IF NOT EXISTS "call_logs_publicId_key" ON "call_logs"("publicId");
