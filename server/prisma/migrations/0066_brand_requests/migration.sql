-- Brand requests: a prospective brand files its basics (name, subdomain,
-- contact) from the platform's public "Set up your brand" page. Nothing is
-- created until a super admin completes setup — the brand row, its database
-- and its admin all come from that step, with the settings, permissions and
-- plans the super admin picks.
--
--   status        pending | approving | approved | declined
--   customDomain  the applicant's own domain; pre-fills the brand's custom
--                 domain at setup, claims nothing before that.
--   passwordHash  the applicant's chosen password, hashed; the admin account is
--                 created with it on approval and the column is blanked then
--                 (or on decline).
--   brandId       set on approval; a plain id, not a foreign key.
--
-- Idempotent (see server/MIGRATIONS.md).

CREATE TABLE IF NOT EXISTS "brand_requests" (
    "id"            TEXT         NOT NULL,
    "status"        TEXT         NOT NULL DEFAULT 'pending',
    "brandName"     TEXT         NOT NULL,
    "slug"          TEXT         NOT NULL,
    "tagline"       TEXT         NOT NULL DEFAULT '',
    "customDomain"  TEXT         NOT NULL DEFAULT '',
    "contactName"   TEXT         NOT NULL,
    "email"         TEXT         NOT NULL,
    "phone"         TEXT         NOT NULL DEFAULT '',
    "country"       TEXT         NOT NULL DEFAULT '',
    "timezone"      TEXT         NOT NULL DEFAULT '',
    "notes"         TEXT         NOT NULL DEFAULT '',
    "passwordHash"  TEXT         NOT NULL DEFAULT '',
    "brandId"       TEXT,
    "reviewedById"  TEXT,
    "reviewedAt"    TIMESTAMP(3),
    "declineReason" TEXT         NOT NULL DEFAULT '',
    "createdAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"     TIMESTAMP(3) NOT NULL,

    CONSTRAINT "brand_requests_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "brand_requests_status_createdAt_idx" ON "brand_requests"("status", "createdAt");
CREATE INDEX IF NOT EXISTS "brand_requests_email_idx" ON "brand_requests"("email");
