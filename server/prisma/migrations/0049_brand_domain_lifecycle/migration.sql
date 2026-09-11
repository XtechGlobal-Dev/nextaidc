-- Brand vanity-domain lifecycle: claim → DNS published by the client → verified.
--
-- A brand's platform SUBDOMAIN (acme.<PLATFORM_DOMAIN>) needs none of this —
-- the wildcard record and its wildcard certificate already cover it. These
-- columns exist for the domain the CLIENT owns, and that domain serves the
-- SPA only: the API, the provider webhooks, the Google OAuth callback and the
-- public /c/* call pages stay on the platform's own API host for every brand.
--
--   domainStatus      none | pending | verified | error
--   domainToken       per-brand nonce published as a TXT record to prove control
--   domainVerifiedAt  when the domain first started serving
--   domainCheckedAt   last verification attempt
--   domainError       why the last check failed ("" when fine)
--
-- Only a VERIFIED domain routes to its brand (CORS, Origin resolution) or is
-- used to build the brand's links. A domain that was already set BEFORE this
-- migration was live by definition — someone pointed it here by hand — so it is
-- grandfathered in as verified with a fresh token, rather than going dark the
-- moment this deploys while waiting on a TXT record nobody was told to publish.
--
-- Idempotent (see server/MIGRATIONS.md).

ALTER TABLE "brands" ADD COLUMN IF NOT EXISTS "domainStatus"     TEXT NOT NULL DEFAULT 'none';
ALTER TABLE "brands" ADD COLUMN IF NOT EXISTS "domainToken"      TEXT NOT NULL DEFAULT '';
ALTER TABLE "brands" ADD COLUMN IF NOT EXISTS "domainVerifiedAt" TIMESTAMP(3);
ALTER TABLE "brands" ADD COLUMN IF NOT EXISTS "domainCheckedAt"  TIMESTAMP(3);
ALTER TABLE "brands" ADD COLUMN IF NOT EXISTS "domainError"      TEXT NOT NULL DEFAULT '';

-- Grandfather domains that predate the lifecycle. Guarded on the empty token so
-- a re-run never touches a row the app has since claimed or verified itself.
UPDATE "brands"
SET "domainStatus"     = 'verified',
    "domainToken"      = md5(random()::text || clock_timestamp()::text || "id"),
    "domainVerifiedAt" = CURRENT_TIMESTAMP,
    "domainCheckedAt"  = CURRENT_TIMESTAMP
WHERE "customDomain" IS NOT NULL
  AND "customDomain" <> ''
  AND "domainStatus" = 'none'
  AND "domainToken"  = '';
