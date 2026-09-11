import "dotenv/config";

/** One-off sweep: move accounts still on the OLD default business hours
 *  (7:00am–5:00pm) to the new 9:00am–5:00pm default. Only exact-match configs
 *  are touched, so any owner who set custom hours is left untouched.
 *
 *  Note: this updates the structured rules.businessHours field. The compiled
 *  master prompt (and the live Vapi agent) refresh on the account's next
 *  Save Changes / sync, same as the other agent-config backfills. */
// A brand's workspace lives in the brand's database (phase 6): BRAND=<slug> picks it.
import { prisma } from "./_brandDb.js";

const OLD_DEFAULT =
  "Monday to Friday, 7:00am – 5:00pm. Closed weekends and public holidays.";
const NEW_DEFAULT =
  "Monday to Friday, 9:00am – 5:00pm. Closed weekends and public holidays.";

async function main() {
  const conversions = await prisma.conversion.findMany({
    select: { id: true, agentConfig: true, user: { select: { email: true } } },
  });

  let updated = 0;
  for (const c of conversions) {
    const config = c.agentConfig as Record<string, any>;
    const current = config?.rules?.businessHours;
    // Only migrate accounts still on the exact old default — never clobber
    // hours an owner deliberately customized.
    if (current !== OLD_DEFAULT) continue;

    config.rules.businessHours = NEW_DEFAULT;
    await prisma.conversion.update({ where: { id: c.id }, data: { agentConfig: config } });
    updated++;
    console.log(`  ✓ ${c.user?.email ?? c.id}`);
  }

  console.log(`✅ ${updated}/${conversions.length} account configs moved to 9–5.`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
