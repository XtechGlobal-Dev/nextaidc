-- Registry of brands whose call data lives in their own Neon project.
--
-- The control-plane half of the hybrid in docs/tenant-databases.md. A row here
-- is rare and deliberate: it means a contract requires that brand's customers'
-- call transcripts to sit in a named region, or in storage no other tenant
-- shares. Everything else about the brand stays in this database.
--
-- The connection strings are AES-256-GCM ciphertext (lib/crypto.ts), never
-- plaintext: they are the keys to a customer's entire call history, and this
-- table is readable by anything with control-plane access.

CREATE TABLE "brand_databases" (
    "brandId"            TEXT NOT NULL,
    "neonProjectId"      TEXT NOT NULL,
    "region"             TEXT NOT NULL DEFAULT '',
    "urlEncrypted"       TEXT NOT NULL,
    "directUrlEncrypted" TEXT NOT NULL,
    -- provisioning | migrating | active | failed | disabled.
    -- ONLY 'active' routes; anything else keeps the brand on the control plane,
    -- so a half-provisioned tenant degrades to normal behaviour rather than
    -- losing calls into a database that is not ready.
    "status"             TEXT NOT NULL DEFAULT 'provisioning',
    "error"              TEXT NOT NULL DEFAULT '',
    "schemaVersion"      TEXT NOT NULL DEFAULT '',
    "provisionedAt"      TIMESTAMP(3),
    "migratedAt"         TIMESTAMP(3),
    "createdAt"          TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"          TIMESTAMP(3) NOT NULL,

    CONSTRAINT "brand_databases_pkey" PRIMARY KEY ("brandId")
);

-- The routing registry is read on a short TTL and filtered by status.
CREATE INDEX "brand_databases_status_idx" ON "brand_databases" ("status");

-- Deleting a brand takes its registry row with it. It does NOT delete the Neon
-- project — that holds the customer's data and is removed only by an explicit
-- decommission, never as a side effect.
ALTER TABLE "brand_databases"
    ADD CONSTRAINT "brand_databases_brandId_fkey"
    FOREIGN KEY ("brandId") REFERENCES "brands"("id") ON DELETE CASCADE ON UPDATE CASCADE;
