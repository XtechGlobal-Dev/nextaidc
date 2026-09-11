-- Brand setup: everything a white-label tenant needs beyond a name and a look.
--
--   Legal identity   legalName, legalAddress, termsUrl, privacyUrl — the footer
--                    of every email the brand sends names the tenant, not the
--                    platform. Blank lines are omitted.
--   Links            websiteUrl, helpUrl — Help links and the email footer.
--   Locale defaults  defaultCountry (ISO-2), defaultTimezone (IANA) — stamped
--                    on the brand's NEW customers when nothing stronger (their
--                    phone number, address, browser) says otherwise.
--   Sign-up policy   signupMode: public | invite. Invite-only brands refuse the
--                    public register endpoints; their admins create accounts.
--   Login copy       loginHeadline, loginBlurb — the sign-in screen's lines.
--   Modules          JSON { booking, transfer, crm, smsToCaller, whatsapp } →
--                    boolean; a missing key means ON. Disabled modules vanish
--                    from the nav and their owner APIs answer 403.
--   Plan catalogue   planIds — SubscriptionPlan ids this brand sells. Empty =
--                    every active platform plan.
--   Trial overrides  trialDays, trialMinutes, cardRequired — NULL = platform.
--   Default voice    defaultVoiceId — the agent voice new customers start on.
--   Scripts          JSON { head, body, footer } — replace the platform's
--                    snippets on a brand host.
--
-- Every column has a default, so existing brands behave exactly as before:
-- public sign-up, every module on, every plan, platform trial terms.
--
-- Idempotent (see server/MIGRATIONS.md).

ALTER TABLE "brands" ADD COLUMN IF NOT EXISTS "legalName"       TEXT    NOT NULL DEFAULT '';
ALTER TABLE "brands" ADD COLUMN IF NOT EXISTS "legalAddress"    TEXT    NOT NULL DEFAULT '';
ALTER TABLE "brands" ADD COLUMN IF NOT EXISTS "termsUrl"        TEXT    NOT NULL DEFAULT '';
ALTER TABLE "brands" ADD COLUMN IF NOT EXISTS "privacyUrl"      TEXT    NOT NULL DEFAULT '';
ALTER TABLE "brands" ADD COLUMN IF NOT EXISTS "websiteUrl"      TEXT    NOT NULL DEFAULT '';
ALTER TABLE "brands" ADD COLUMN IF NOT EXISTS "helpUrl"         TEXT    NOT NULL DEFAULT '';
ALTER TABLE "brands" ADD COLUMN IF NOT EXISTS "defaultCountry"  TEXT    NOT NULL DEFAULT '';
ALTER TABLE "brands" ADD COLUMN IF NOT EXISTS "defaultTimezone" TEXT    NOT NULL DEFAULT '';
ALTER TABLE "brands" ADD COLUMN IF NOT EXISTS "signupMode"      TEXT    NOT NULL DEFAULT 'public';
ALTER TABLE "brands" ADD COLUMN IF NOT EXISTS "loginHeadline"   TEXT    NOT NULL DEFAULT '';
ALTER TABLE "brands" ADD COLUMN IF NOT EXISTS "loginBlurb"      TEXT    NOT NULL DEFAULT '';
ALTER TABLE "brands" ADD COLUMN IF NOT EXISTS "modules"         JSONB   NOT NULL DEFAULT '{}';
ALTER TABLE "brands" ADD COLUMN IF NOT EXISTS "planIds"         JSONB   NOT NULL DEFAULT '[]';
ALTER TABLE "brands" ADD COLUMN IF NOT EXISTS "trialDays"       INTEGER;
ALTER TABLE "brands" ADD COLUMN IF NOT EXISTS "trialMinutes"    INTEGER;
ALTER TABLE "brands" ADD COLUMN IF NOT EXISTS "cardRequired"    BOOLEAN;
ALTER TABLE "brands" ADD COLUMN IF NOT EXISTS "defaultVoiceId"  TEXT    NOT NULL DEFAULT '';
ALTER TABLE "brands" ADD COLUMN IF NOT EXISTS "scripts"         JSONB   NOT NULL DEFAULT '{}';
