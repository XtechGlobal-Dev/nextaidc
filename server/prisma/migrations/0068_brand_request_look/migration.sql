-- Brand requests carry the applicant's look: a colour palette and typeface from
-- the brand catalog, and the logos they uploaded (public storage URLs). All
-- pre-fill "Complete setup"; the logos become the brand's own there, or are
-- deleted when the request is declined. "" = not chosen.
--
-- Idempotent (see server/MIGRATIONS.md).

ALTER TABLE "brand_requests" ADD COLUMN IF NOT EXISTS "themePreset"  TEXT NOT NULL DEFAULT '';
ALTER TABLE "brand_requests" ADD COLUMN IF NOT EXISTS "primaryColor" TEXT NOT NULL DEFAULT '';
ALTER TABLE "brand_requests" ADD COLUMN IF NOT EXISTS "accentColor"  TEXT NOT NULL DEFAULT '';
ALTER TABLE "brand_requests" ADD COLUMN IF NOT EXISTS "fontFamily"   TEXT NOT NULL DEFAULT '';
ALTER TABLE "brand_requests" ADD COLUMN IF NOT EXISTS "logoLightUrl" TEXT NOT NULL DEFAULT '';
ALTER TABLE "brand_requests" ADD COLUMN IF NOT EXISTS "logoDarkUrl"  TEXT NOT NULL DEFAULT '';
ALTER TABLE "brand_requests" ADD COLUMN IF NOT EXISTS "faviconUrl"   TEXT NOT NULL DEFAULT '';
