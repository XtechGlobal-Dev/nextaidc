import "dotenv/config";
import { prisma } from "../src/prisma.js";

// READ-ONLY. What the retired brand billing (docs/brand-as-customer-plan.md, phase 6) still has open, so the owner can
// settle it before its tables are dropped. Nothing here writes to the database or to Stripe.
//
//   npm run brand-billing:report
//
// 1. Brands still subscribed to the platform — their Stripe subscriptions keep charging until cancelled in Stripe.
// 2. Brand wallet balances — markup the platform still owes a brand (credits − payouts − reversals).
// 3. Brand marked-up Stripe Prices — customers on one keep paying base + markup until moved to the plan's own Price.

const money = (cents: number, currency: string) => `${(cents / 100).toFixed(2)} ${currency.toUpperCase()}`;

try {
  const brands = new Map(
    (await prisma.brand.findMany({ select: { id: true, name: true, slug: true } })).map((b) => [b.id, b]),
  );
  const label = (id: string) => {
    const b = brands.get(id);
    return b ? `${b.name} (${b.slug})` : id;
  };

  const billing = await prisma.brandBilling.findMany({
    where: { stripeSubscriptionId: { not: null }, status: { not: "canceled" } },
  });
  console.log(`\n1. Brand subscriptions to the platform still live: ${billing.length}`);
  for (const b of billing) {
    console.log(`   - ${label(b.brandId)}: ${b.stripeSubscriptionId} (status ${b.status}) — cancel in Stripe`);
  }

  // Entries are signed (credits +, payouts and reversals −), so a balance is their plain sum.
  const sums = await prisma.brandWalletEntry.groupBy({
    by: ["brandId", "currency"],
    _sum: { amountCents: true },
  });
  const balances = new Map<string, number>();
  for (const e of sums) balances.set(`${e.brandId}|${e.currency}`, e._sum?.amountCents ?? 0);
  const owed = [...balances].filter(([, cents]) => cents !== 0);
  console.log(`\n2. Brand wallet balances not paid out: ${owed.length}`);
  for (const [key, cents] of owed) {
    const [brandId, currency] = key.split("|");
    console.log(`   - ${label(brandId)}: ${money(cents, currency)}`);
  }

  const prices = await prisma.brandPlanAddon.findMany({
    where: { addonCents: { gt: 0 }, stripePriceId: { not: "" } },
    include: { plan: { select: { displayName: true, stripePriceId: true, priceCents: true, currency: true } } },
  });
  console.log(`\n3. Brand marked-up Stripe Prices: ${prices.length}`);
  for (const p of prices) {
    console.log(
      `   - ${label(p.brandId)} · ${p.plan.displayName}: ${p.stripePriceId} (base ${money(p.plan.priceCents, p.plan.currency)} + ${money(
        p.addonCents,
        p.plan.currency,
      )}) — move its subscribers to ${p.plan.stripePriceId ?? "the plan's own Price"}, then archive it`,
    );
  }

  const clean = !billing.length && !owed.length && !prices.length;
  console.log(
    clean
      ? "\nNothing open — the retired tables can be dropped.\n"
      : "\nSettle the items above in Stripe (and pay out any balances) before the retired tables are dropped.\n",
  );
} finally {
  await prisma.$disconnect();
}
