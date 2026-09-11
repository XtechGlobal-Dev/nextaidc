-- Phase 1 — identity. A brand's people live in the brand's own database.
--
-- Sign-in on a brand's door and every session it issues read THIS table.
-- During the transition the control plane keeps a mirror row with the same id
-- (services/identityMirror.ts writes both), because profiles, calls, tickets
-- and numbers there still point at it; the mirror goes once those move here.
--
-- The control plane's Role minus SUPER_ADMIN: the platform owner never lives
-- in a brand's database.
CREATE TYPE "Role" AS ENUM ('USER', 'ADMIN', 'STAFF', 'RESELLER');

CREATE TABLE "users" (
    "id"                TEXT             NOT NULL,
    "email"             TEXT             NOT NULL,
    "passwordHash"      TEXT             NOT NULL,
    "fullName"          TEXT             NOT NULL,
    "role"              "Role"           NOT NULL DEFAULT 'USER',
    "permissions"       TEXT[]           DEFAULT ARRAY[]::TEXT[],
    "staffRoleId"       TEXT,
    "twoFactorEnabled"  BOOLEAN          NOT NULL DEFAULT false,
    "twoFactorSecret"   TEXT,
    "referralCode"      TEXT,
    "commissionPercent" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "referredById"      TEXT,
    "emailOptOutAt"     TIMESTAMP(3),
    "createdAt"         TIMESTAMP(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"         TIMESTAMP(3)     NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- Unique WITHIN this brand. The same email may be a customer of two brands —
-- they are two products, and two logins (decision Q1 of the expansion plan).
CREATE UNIQUE INDEX "users_email_key" ON "users" ("email");
CREATE UNIQUE INDEX "users_referralCode_key" ON "users" ("referralCode");
