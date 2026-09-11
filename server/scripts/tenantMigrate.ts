import "dotenv/config";
import { prisma } from "../src/prisma.js";
import { migrateTenant, markStaleTenants } from "../src/services/tenantProvisioning.js";
import { latestTenantMigration } from "../src/services/tenantMigrations.js";
import { backfillStripeCustomerIndex } from "../src/services/stripeCustomers.js";

/* ------------------------------------------------------------------ *
 *  Bring every brand's database up to the newest tenant migration.
 *
 *    npm run tenant:migrate
 *
 *  Runs in the deploy right after the control plane's own migration, and by
 *  hand after adding a file under prisma/tenant/migrations. Each tenant is
 *  independent: one that fails is left in `migrating` (its door shut, the
 *  error on its brand page) and the rest still get done. Exits non-zero if
 *  any failed, so a deploy that could not update a brand fails loudly.
 * ------------------------------------------------------------------ */

const target = latestTenantMigration();
console.log(`Tenant schema target: ${target || "(no migrations on disk)"}\n`);

const stale = await markStaleTenants();
if (stale.length) console.log(`${stale.length} tenant(s) were behind and have stopped routing.\n`);

// Control-plane housekeeping that rides along with every deploy: the Stripe
// customer index is how a payment finds its brand, so it is rebuilt from the
// profiles here — a one-off after it was introduced, a repair every time after.
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
