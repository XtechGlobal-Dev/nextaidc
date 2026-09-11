-- First shape of a brand's own database.
--
-- Applied to every tenant — a fresh Neon project, or a schema on the platform's
-- database in development — by `prisma migrate deploy --schema
-- prisma/tenant/schema.prisma` (services/tenantMigrations.ts runs it). Later
-- phases add the brand's customers, calls, numbers and tickets here, one
-- migration each; this one carries only what phase 0 needs.

-- Exactly one row: which brand this database belongs to. tenantFor() reads it
-- the first time it connects and refuses to serve a brand from a database that
-- names a different one — a mis-wired connection string must fail loudly, never
-- route one brand's customers into another's.
CREATE TABLE "tenant_info" (
    "id"            TEXT         NOT NULL DEFAULT 'self',
    "brandId"       TEXT         NOT NULL,
    "brandSlug"     TEXT         NOT NULL,
    "provisionedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tenant_info_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "tenant_info_brandId_key" ON "tenant_info" ("brandId");

-- The caller-personal half of a call — what today's optional tenant split
-- already moves (see docs/tenant-databases.md). Kept as-is so nothing about
-- calls changes in phase 0; phase 2 folds it back into a whole call_logs table
-- living here.
--
-- The join key is (callId, createdAt): the same composite the control plane
-- uses, so this table partitions by month exactly as call_logs does.
CREATE TABLE "call_details" (
    -- Matches call_logs.id in the control plane. Not a foreign key — it cannot
    -- be, the referenced row is in another database — so the application keeps
    -- the two sides in step. tenantDb.ts deletes from here whenever a call is
    -- removed there.
    "callId"                   TEXT         NOT NULL,
    "createdAt"                TIMESTAMP(3) NOT NULL,

    -- Who called, and what was said.
    "callerName"               TEXT         NOT NULL DEFAULT 'Unknown',
    "callerNumber"             TEXT         NOT NULL DEFAULT '',
    "summary"                  TEXT         NOT NULL DEFAULT '',
    "summaryTranslated"        TEXT,
    "purpose"                  TEXT         NOT NULL DEFAULT '',
    "transcript"               JSONB        NOT NULL DEFAULT '[]',
    "analysis"                 JSONB        NOT NULL DEFAULT '{}',
    "transcriptTranslated"     JSONB,
    "recordingUrl"             TEXT,

    CONSTRAINT "call_details_pkey" PRIMARY KEY ("callId", "createdAt")
) PARTITION BY RANGE ("createdAt");

-- Catch-all, same reasoning as the control plane: a late partition sweep must
-- never be able to reject a write and lose a real customer conversation.
CREATE TABLE "call_details_default" PARTITION OF "call_details" DEFAULT;

-- The inbox's text search runs here, because these are the columns it
-- searches. Trigram indexes so `contains` is not a scan. The extension is
-- pinned to `public` and the operator class qualified, so this works both on
-- a fresh Neon project and inside a schema on the platform's database (where
-- the search_path is the tenant schema alone).
CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA public;
CREATE INDEX "call_details_callerName_trgm" ON "call_details" USING gin ("callerName" public.gin_trgm_ops);
CREATE INDEX "call_details_summary_trgm"    ON "call_details" USING gin ("summary" public.gin_trgm_ops);
CREATE INDEX "call_details_createdAt_idx"   ON "call_details" ("createdAt");
