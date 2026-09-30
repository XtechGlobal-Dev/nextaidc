-- Brand billing, feature add-ons and monthly limits.
--
-- The platform charging a BRAND (the opposite direction to the wallet):
--   brands.platformFeeCents/Currency  fixed monthly fee; 0 = none, which is what
--                                     every existing brand keeps
--   brands.featurePrices              { moduleId: monthly cents } — modules sold
--                                     as add-ons, locked until bought
--   brands.purchasedFeatures          module ids the brand is paying for
--   brands.monthlyMinuteLimit/AiLimit caps across all the brand's customers per
--                                     UTC month; NULL = no cap
--   brands.serviceHold                why the brand's AI is paused ("" = it isn't)
--   brand_billing                     the brand's Stripe customer/subscription
--   brand_usage_monthly               metered minutes + AI interactions per month
--
-- Every new column has a default, so existing brands behave exactly as before.
-- Idempotent (see server/MIGRATIONS.md).

ALTER TABLE "brands" ADD COLUMN IF NOT EXISTS "platformFeeCents"    INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "brands" ADD COLUMN IF NOT EXISTS "platformFeeCurrency" TEXT    NOT NULL DEFAULT 'usd';
ALTER TABLE "brands" ADD COLUMN IF NOT EXISTS "featurePrices"       JSONB   NOT NULL DEFAULT '{}';
ALTER TABLE "brands" ADD COLUMN IF NOT EXISTS "purchasedFeatures"   JSONB   NOT NULL DEFAULT '[]';
ALTER TABLE "brands" ADD COLUMN IF NOT EXISTS "monthlyMinuteLimit"  INTEGER;
ALTER TABLE "brands" ADD COLUMN IF NOT EXISTS "monthlyAiLimit"      INTEGER;
ALTER TABLE "brands" ADD COLUMN IF NOT EXISTS "serviceHold"         TEXT    NOT NULL DEFAULT '';

CREATE TABLE IF NOT EXISTS "brand_billing" (
    "brandId"              TEXT         NOT NULL,
    "stripeCustomerId"     TEXT,
    "stripeSubscriptionId" TEXT,
    "status"               TEXT         NOT NULL DEFAULT 'awaiting_card',
    "requiredSince"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "pastDueSince"         TIMESTAMP(3),
    "currentPeriodEnd"     TIMESTAMP(3),
    "lastPaidAt"           TIMESTAMP(3),
    "lastPaidCents"        INTEGER,
    "cardBrand"            TEXT         NOT NULL DEFAULT '',
    "cardLast4"            TEXT         NOT NULL DEFAULT '',
    "createdAt"            TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"            TIMESTAMP(3) NOT NULL,

    CONSTRAINT "brand_billing_pkey" PRIMARY KEY ("brandId")
);

CREATE UNIQUE INDEX IF NOT EXISTS "brand_billing_stripeCustomerId_key" ON "brand_billing"("stripeCustomerId");
CREATE UNIQUE INDEX IF NOT EXISTS "brand_billing_stripeSubscriptionId_key" ON "brand_billing"("stripeSubscriptionId");

DO $$ BEGIN
  ALTER TABLE "brand_billing" ADD CONSTRAINT "brand_billing_brandId_fkey"
    FOREIGN KEY ("brandId") REFERENCES "brands"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS "brand_usage_monthly" (
    "brandId"        TEXT         NOT NULL,
    "period"         TEXT         NOT NULL,
    "minutes"        INTEGER      NOT NULL DEFAULT 0,
    "aiInteractions" INTEGER      NOT NULL DEFAULT 0,
    "minutesAlerted" INTEGER      NOT NULL DEFAULT 0,
    "aiAlerted"      INTEGER      NOT NULL DEFAULT 0,
    "updatedAt"      TIMESTAMP(3) NOT NULL,

    CONSTRAINT "brand_usage_monthly_pkey" PRIMARY KEY ("brandId", "period")
);

DO $$ BEGIN
  ALTER TABLE "brand_usage_monthly" ADD CONSTRAINT "brand_usage_monthly_brandId_fkey"
    FOREIGN KEY ("brandId") REFERENCES "brands"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
