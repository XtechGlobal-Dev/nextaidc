-- Brand plans: what a BRAND pays the PLATFORM, as a catalog — separate from
-- subscription_plans (what a brand sells its own customers).
--
--   brand_plans         name, monthly price + currency, the modules included,
--                       optional monthly caps; archived plans stay on the brands
--                       using them but aren't offered
--   brand_addon_prices  per module: the monthly add-on price for brands whose plan
--                       doesn't include it; no row / inactive = not offered
--   brands.brandPlanId  the plan a brand is on (NULL = billing set by hand)
--   brand_requests      the plan the applicant chose, and their saved card
--                       (charged only at "Complete setup")
--
-- Idempotent (see server/MIGRATIONS.md).

CREATE TABLE IF NOT EXISTS "brand_plans" (
    "id"                 TEXT         NOT NULL,
    "name"               TEXT         NOT NULL,
    "description"        TEXT         NOT NULL DEFAULT '',
    "priceCents"         INTEGER      NOT NULL,
    "currency"           TEXT         NOT NULL DEFAULT 'usd',
    "features"           JSONB        NOT NULL DEFAULT '[]',
    "monthlyMinuteLimit" INTEGER,
    "monthlyAiLimit"     INTEGER,
    "active"             BOOLEAN      NOT NULL DEFAULT true,
    "sortOrder"          INTEGER      NOT NULL DEFAULT 0,
    "createdAt"          TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"          TIMESTAMP(3) NOT NULL,

    CONSTRAINT "brand_plans_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "brand_addon_prices" (
    "moduleId"   TEXT         NOT NULL,
    "priceCents" INTEGER      NOT NULL,
    "active"     BOOLEAN      NOT NULL DEFAULT true,
    "updatedAt"  TIMESTAMP(3) NOT NULL,

    CONSTRAINT "brand_addon_prices_pkey" PRIMARY KEY ("moduleId")
);

ALTER TABLE "brands" ADD COLUMN IF NOT EXISTS "brandPlanId" TEXT;
DO $$ BEGIN
  ALTER TABLE "brands" ADD CONSTRAINT "brands_brandPlanId_fkey"
    FOREIGN KEY ("brandPlanId") REFERENCES "brand_plans"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

ALTER TABLE "brand_requests" ADD COLUMN IF NOT EXISTS "brandPlanId"      TEXT NOT NULL DEFAULT '';
ALTER TABLE "brand_requests" ADD COLUMN IF NOT EXISTS "stripeCustomerId" TEXT NOT NULL DEFAULT '';
ALTER TABLE "brand_requests" ADD COLUMN IF NOT EXISTS "paymentMethodId"  TEXT NOT NULL DEFAULT '';
ALTER TABLE "brand_requests" ADD COLUMN IF NOT EXISTS "cardBrand"        TEXT NOT NULL DEFAULT '';
ALTER TABLE "brand_requests" ADD COLUMN IF NOT EXISTS "cardLast4"        TEXT NOT NULL DEFAULT '';
