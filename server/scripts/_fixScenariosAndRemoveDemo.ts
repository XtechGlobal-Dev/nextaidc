import "dotenv/config";

/** One-off, user-requested:
 *  1. Capitalize scenario If/Then first letters for the two named accounts
 *     (michaelbt8699@gmail.com, admin@hello22.ai) — the only ones still lowercase.
 *  2. Delete the demo@hello22.ai account entirely (no longer wanted). Prisma
 *     cascades remove its profile, conversion + call logs, CRM row, and
 *     notifications. */
// A brand's workspace lives in the brand's database (phase 6): BRAND=<slug> picks it.
import { prisma } from "./_brandDb.js";

const TARGET_EMAILS = ["michaelbt8699@gmail.com", "admin@hello22.ai"];
const DEMO_EMAIL = "demo@hello22.ai";

const capFirst = (s: string) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);

async function main() {
  for (const email of TARGET_EMAILS) {
    const user = await prisma.user.findUnique({
      where: { email },
      select: { conversion: { select: { id: true, agentConfig: true } } },
    });
    if (!user?.conversion) {
      console.log(`  – ${email}: no conversion, skipped`);
      continue;
    }
    const config = user.conversion.agentConfig as Record<string, any>;
    const scenarios = config?.rules?.scenarioHandling;
    if (!Array.isArray(scenarios) || scenarios.length === 0) {
      console.log(`  – ${email}: no scenarios, skipped`);
      continue;
    }
    config.rules.scenarioHandling = scenarios.map((s: any) => ({
      ...s,
      ifText: capFirst(String(s.ifText ?? "")),
      thenText: capFirst(String(s.thenText ?? "")),
    }));
    await prisma.conversion.update({
      where: { id: user.conversion.id },
      data: { agentConfig: config },
    });
    console.log(`  ✓ ${email}: scenario texts capitalized`);
  }

  const demo = await prisma.user.findUnique({ where: { email: DEMO_EMAIL }, select: { id: true } });
  if (demo) {
    await prisma.user.delete({ where: { id: demo.id } });
    console.log(`  ✓ ${DEMO_EMAIL}: account deleted (cascade removed its data)`);
  } else {
    console.log(`  – ${DEMO_EMAIL}: not found (already removed)`);
  }

  console.log("✅ Done.");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
