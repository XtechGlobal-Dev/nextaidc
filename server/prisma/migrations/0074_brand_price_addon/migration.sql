-- Brand price add-on and wallet, back (owner, 9 Oct 2026 — reverses decision 4 of docs/brand-as-customer-plan.md).
--
-- A brand adds its own charge on top of a platform plan (199 + 20); its customers pay 219 to the platform's Stripe
-- and the add-on share is credited to the brand's WALLET when the invoice is paid. The platform pays the brand out
-- by hand and records the payout against the wallet. Existing subscribers keep the Price they signed up on when
-- the brand changes its add-on.
--
--   brands.addonEditable / maxAddonCents  may the brand's admin set add-ons, and the cap per cycle (NULL = none)
--   brand_plan_addons                     one row per (brand, plan): the add-on and the CURRENT brand Price
--   brand_plan_prices                     every brand Price ever created, with its base/add-on split, so a
--                                         renewal on an older Price still credits the right share
--   brand_wallet_entries                  the wallet ledger: credit (+), payout (−), reversal (−)
--
-- The tables were created by 0051/0052 and only dropped from schema.prisma, so on a database that still has them
-- everything below is a no-op except brand_plan_prices (backfilled from the live add-on Prices).
--
-- Idempotent (see server/MIGRATIONS.md).

ALTER TABLE "brands" ADD COLUMN IF NOT EXISTS "addonEditable" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "brands" ADD COLUMN IF NOT EXISTS "maxAddonCents" INTEGER;

CREATE TABLE IF NOT EXISTS "brand_plan_addons" (
  "id"            TEXT         NOT NULL,
  "brandId"       TEXT         NOT NULL,
  "planId"        TEXT         NOT NULL,
  "addonCents"    INTEGER      NOT NULL DEFAULT 0,
  "stripePriceId" TEXT         NOT NULL DEFAULT '',
  "createdAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"     TIMESTAMP(3) NOT NULL,
  CONSTRAINT "brand_plan_addons_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "brand_plan_addons_brandId_planId_key" ON "brand_plan_addons" ("brandId", "planId");
CREATE INDEX IF NOT EXISTS "brand_plan_addons_stripePriceId_idx" ON "brand_plan_addons" ("stripePriceId");

CREATE TABLE IF NOT EXISTS "brand_plan_prices" (
  "stripePriceId" TEXT         NOT NULL,
  "brandId"       TEXT         NOT NULL,
  "planId"        TEXT         NOT NULL,
  "baseCents"     INTEGER      NOT NULL,
  "addonCents"    INTEGER      NOT NULL,
  "currency"      TEXT         NOT NULL DEFAULT 'usd',
  "createdAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "brand_plan_prices_pkey" PRIMARY KEY ("stripePriceId")
);
CREATE INDEX IF NOT EXISTS "brand_plan_prices_brandId_planId_idx" ON "brand_plan_prices" ("brandId", "planId");

CREATE TABLE IF NOT EXISTS "brand_wallet_entries" (
  "id"               TEXT         NOT NULL,
  "brandId"          TEXT         NOT NULL,
  "type"             TEXT         NOT NULL,
  "amountCents"      INTEGER      NOT NULL,
  "currency"         TEXT         NOT NULL DEFAULT 'usd',
  "stripeInvoiceId"  TEXT,
  "relatedInvoiceId" TEXT,
  "customerId"       TEXT,
  "planId"           TEXT,
  "note"             TEXT         NOT NULL DEFAULT '',
  "reference"        TEXT         NOT NULL DEFAULT '',
  "createdById"      TEXT,
  "createdAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "brand_wallet_entries_pkey" PRIMARY KEY ("id")
);
ALTER TABLE "brand_wallet_entries" ADD COLUMN IF NOT EXISTS "relatedInvoiceId" TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS "brand_wallet_entries_stripeInvoiceId_key" ON "brand_wallet_entries" ("stripeInvoiceId");
CREATE INDEX IF NOT EXISTS "brand_wallet_entries_brandId_createdAt_idx" ON "brand_wallet_entries" ("brandId", "createdAt");
CREATE INDEX IF NOT EXISTS "brand_wallet_entries_relatedInvoiceId_idx" ON "brand_wallet_entries" ("relatedInvoiceId");

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'brand_plan_addons_brandId_fkey') THEN
    ALTER TABLE "brand_plan_addons" ADD CONSTRAINT "brand_plan_addons_brandId_fkey"
      FOREIGN KEY ("brandId") REFERENCES "brands" ("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'brand_plan_addons_planId_fkey') THEN
    ALTER TABLE "brand_plan_addons" ADD CONSTRAINT "brand_plan_addons_planId_fkey"
      FOREIGN KEY ("planId") REFERENCES "subscription_plans" ("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'brand_wallet_entries_brandId_fkey') THEN
    ALTER TABLE "brand_wallet_entries" ADD CONSTRAINT "brand_wallet_entries_brandId_fkey"
      FOREIGN KEY ("brandId") REFERENCES "brands" ("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END
$$;

-- The Prices brands already sell through, at today's base price (the best record there is of their split).
INSERT INTO "brand_plan_prices" ("stripePriceId", "brandId", "planId", "baseCents", "addonCents", "currency")
SELECT a."stripePriceId", a."brandId", a."planId", p."priceCents", a."addonCents", p."currency"
FROM "brand_plan_addons" a
JOIN "subscription_plans" p ON p."id" = a."planId"
WHERE a."stripePriceId" <> '' AND a."addonCents" > 0
ON CONFLICT ("stripePriceId") DO NOTHING;
