-- Multi-tenant white-label brands + the SUPER_ADMIN role.
--
-- One deployment, many brands. A brand is a front door: its own subdomain,
-- logos, palette, font and messaging senders, owned by a brand ADMIN. The
-- SUPER_ADMIN creates brands and is the only role that can reach the platform
-- integration keys (Admin → Settings) and the API Center.
--
-- `users.brandId` is nullable and defaults to NULL, so every existing row stays
-- exactly what it is today — a platform-level account — and this deploys with
-- no behaviour change and no backfill.
--
-- Idempotent (see server/MIGRATIONS.md).

-- 1. Roles. ADD VALUE cannot run inside a transaction on older PGs, and Prisma
--    wraps migrations, so guard it with a DO block that only fires when absent.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_enum e
    JOIN pg_type t ON t.oid = e.enumtypid
    WHERE t.typname = 'Role' AND e.enumlabel = 'SUPER_ADMIN'
  ) THEN
    ALTER TYPE "Role" ADD VALUE 'SUPER_ADMIN';
  END IF;
END
$$;

-- 2. Brand lifecycle enum.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'BrandStatus') THEN
    CREATE TYPE "BrandStatus" AS ENUM ('active', 'suspended');
  END IF;
END
$$;

-- 3. Brands.
CREATE TABLE IF NOT EXISTS "brands" (
  "id"              TEXT          NOT NULL,
  "name"            TEXT          NOT NULL,
  "slug"            TEXT          NOT NULL,
  "customDomain"    TEXT,
  "status"          "BrandStatus" NOT NULL DEFAULT 'active',
  "logoLightUrl"    TEXT          NOT NULL DEFAULT '',
  "logoDarkUrl"     TEXT          NOT NULL DEFAULT '',
  "faviconUrl"      TEXT          NOT NULL DEFAULT '',
  "themePreset"     TEXT          NOT NULL DEFAULT 'ocean',
  "primaryColor"    TEXT          NOT NULL DEFAULT '#2C76ED',
  "accentColor"     TEXT          NOT NULL DEFAULT '#7C5CFC',
  "fontFamily"      TEXT          NOT NULL DEFAULT 'inter',
  "fontStyle"       TEXT          NOT NULL DEFAULT 'business',
  "darkModeDefault" BOOLEAN       NOT NULL DEFAULT false,
  "tagline"         TEXT          NOT NULL DEFAULT '',
  "supportEmail"    TEXT          NOT NULL DEFAULT '',
  "supportPhone"    TEXT          NOT NULL DEFAULT '',
  "createdById"     TEXT,
  "createdAt"       TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"       TIMESTAMP(3)  NOT NULL,
  CONSTRAINT "brands_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "brands_slug_key" ON "brands" ("slug");
CREATE UNIQUE INDEX IF NOT EXISTS "brands_customDomain_key" ON "brands" ("customDomain");

-- 4. Per-brand integration overrides (same key namespace as platform_settings;
--    secrets encrypted at rest by the app, exactly like platform settings).
CREATE TABLE IF NOT EXISTS "brand_settings" (
  "brandId"   TEXT         NOT NULL,
  "key"       TEXT         NOT NULL,
  "value"     TEXT         NOT NULL,
  "isSecret"  BOOLEAN      NOT NULL DEFAULT true,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "brand_settings_pkey" PRIMARY KEY ("brandId", "key")
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'brand_settings_brandId_fkey'
  ) THEN
    ALTER TABLE "brand_settings"
      ADD CONSTRAINT "brand_settings_brandId_fkey"
      FOREIGN KEY ("brandId") REFERENCES "brands"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END
$$;

-- 5. Tenant membership on users. NULL = platform-level (the SUPER_ADMIN and
--    every account that predates brands).
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "brandId" TEXT;

CREATE INDEX IF NOT EXISTS "users_brandId_idx" ON "users" ("brandId");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'users_brandId_fkey'
  ) THEN
    ALTER TABLE "users"
      ADD CONSTRAINT "users_brandId_fkey"
      FOREIGN KEY ("brandId") REFERENCES "brands"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END
$$;
