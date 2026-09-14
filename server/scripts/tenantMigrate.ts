import "dotenv/config";
import { prisma } from "../src/prisma.js";
import { migrateTenant, markStaleTenants } from "../src/services/tenantProvisioning.js";
import { latestTenantMigration } from "../src/services/tenantMigrations.js";
import { backfillStripeCustomerIndex } from "../src/services/stripeCustomers.js";

// `npm run tenant:migrate` — bring every brand DB to the newest tenant migration. Tenants are independent:
// a failure leaves that one in `migrating` (door shut) and the rest proceed; exits non-zero if any failed.

const target = latestTenantMigration();
console.log(`Tenant schema target: ${target || "(no migrations on disk)"}\n`);

const stale = await markStaleTenants();
if (stale.length) console.log(`${stale.length} tenant(s) were behind and have stopped routing.\n`);

// The Stripe customer index is how a payment finds its brand; rebuild it every deploy as a repair.
const indexed = await backfillStripeCustomerIndex();
if (indexed) console.log(`Stripe customer index: ${indexed} customer(s) indexed.\n`);

const rows = await prisma.brandDatabase.findMany({
  where: { status: { in: ["active", "migrating"] } },
  include: { brand: { select: { slug: true } } },
  orderBy: { createdAt: "asc" },
});

let failed = 0;
for (const row of rows) {
  try {
    const { from, to } = await migrateTenant(row.brandId);
    console.log(`  ✓ ${row.brand.slug}  ${from || "none"} → ${to}`);
  } catch (e) {
    failed++;
    console.error(`  ✗ ${row.brand.slug}  ${e instanceof Error ? e.message : e}`);
  }
}

console.log(`\n${rows.length - failed} of ${rows.length} tenant(s) current.`);
await prisma.$disconnect();
if (failed > 0) process.exit(1);
