-- Wallet reversals: when a customer's charge is refunded, the brand's credit
-- for that invoice is undone in proportion. `relatedInvoiceId` ties each
-- reversal back to the credit it reverses; it is NOT unique, because a partial
-- refund followed by another produces two reversals for one invoice. The
-- webhook works from Stripe's cumulative `amount_refunded`, so replays never
-- double-book.
--
-- Idempotent (see server/MIGRATIONS.md).

ALTER TABLE "brand_wallet_entries" ADD COLUMN IF NOT EXISTS "relatedInvoiceId" TEXT;
CREATE INDEX IF NOT EXISTS "brand_wallet_entries_relatedInvoiceId_idx"
  ON "brand_wallet_entries" ("relatedInvoiceId");
