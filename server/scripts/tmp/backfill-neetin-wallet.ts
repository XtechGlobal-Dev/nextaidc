// One-off: book neetin@yopmail.com's already-paid invoice (My Pets, Business plan) into the platform ledger
// so the brand wallet gets its addon share. Idempotent — a second run is a no-op.
// Run from server/:  npx tsx scripts/tmp/backfill-neetin-wallet.ts
import { prisma } from "../../src/prisma.js";
import { recordPaidInvoice } from "../../src/services/platformLedger.js";

const out = await recordPaidInvoice({
  invoiceId: "in_1UGqpyIr9a2uM8NRlKYwPpLN",
  customerId: "cus_VHPepsp0gTKWGx",
  amountPaidCents: 35900,
  priceId: "price_1UGqobIr9a2uM8NRkuDrhuMn",
  currency: "usd",
  source: "reconcile",
});
console.log("OUTCOME", {
  credited: out.credited,
  alreadyBooked: out.alreadyBooked,
  unrouted: out.unrouted,
  ledger: out.ledger && {
    totalCents: out.ledger.totalCents,
    platformCents: out.ledger.platformCents,
    brandCents: out.ledger.brandCents,
  },
});
console.log("WALLET", await prisma.brandWalletEntry.findMany({ where: { brandId: "cmu58d3j90002ac0wqngkyfse" } }));
await prisma.$disconnect();
