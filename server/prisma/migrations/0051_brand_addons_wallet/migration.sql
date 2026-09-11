-- Brand pricing addons and the brand wallet.
--
-- The platform owner sets a plan's base price (199). A brand adds its own
-- charge on top (20) and its customers see 219. The customer pays the full 219
-- to the platform's Stripe; the addon share (20) is credited to the brand's
-- WALLET when the invoice is paid; the platform owner pays the brand out by
-- hand and records the payout against the wallet.
--
--   brand_plan_addons     one row per (brand, plan): the addon and the Stripe
--                         Price the brand's customers subscribe through.
--   brand_wallet_entries  the ledger. Balance = sum(amountCents) per currency.
--                         credit (+), payout (−), reversal (−). The invoice id
--                         is UNIQUE so a credit can never be booked twice,
--                         whichever invoice-paid path sees it first.
--   brands.addonEditable  may the brand's own admin set addons (default yes).
--   brands.maxAddonCents  cap per cycle; NULL = no cap.
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

CREATE UNIQUE INDEX IF NOT EXISTS "brand_plan_addons_brandId_planId_key"
  ON "brand_plan_addons" ("brandId", "planId");
CREATE INDEX IF NOT EXISTS "brand_plan_addons_stripePriceId_idx"
  ON "brand_plan_addons" ("stripePriceId");

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'brand_plan_addons_brandId_fkey') THEN
    ALTER TABLE "brand_plan_addons"
      ADD CONSTRAINT "brand_plan_addons_brandId_fkey"
      FOREIGN KEY ("brandId") REFERENCES "brands" ("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'brand_plan_addons_planId_fkey') THEN
    ALTER TABLE "brand_plan_addons"
      ADD CONSTRAINT "brand_plan_addons_planId_fkey"
      FOREIGN KEY ("planId") REFERENCES "subscription_plans" ("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END
$$;

CREATE TABLE IF NOT EXISTS "brand_wallet_entries" (
  "id"              TEXT         NOT NULL,
  "brandId"         TEXT         NOT NULL,
  "type"            TEXT         NOT NULL,
  "amountCents"     INTEGER      NOT NULL,
  "currency"        TEXT         NOT NULL DEFAULT 'usd',
  "stripeInvoiceId" TEXT,
  "customerId"      TEXT,
  "planId"          TEXT,
  "note"            TEXT         NOT NULL DEFAULT '',
  "reference"       TEXT         NOT NULL DEFAULT '',
  "createdById"     TEXT,
  "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "brand_wallet_entries_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "brand_wallet_entries_stripeInvoiceId_key"
  ON "brand_wallet_entries" ("stripeInvoiceId");
CREATE INDEX IF NOT EXISTS "brand_wallet_entries_brandId_createdAt_idx"
  ON "brand_wallet_entries" ("brandId", "createdAt");

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'brand_wallet_entries_brandId_fkey') THEN
    ALTER TABLE "brand_wallet_entries"
      ADD CONSTRAINT "brand_wallet_entries_brandId_fkey"
      FOREIGN KEY ("brandId") REFERENCES "brands" ("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END
$$;
