import "dotenv/config";

// One-off: capitalize scenario If/Then text in every saved config (cosmetic; prompts recompile on next save).
// A brand's workspace lives in the brand's database (phase 6): BRAND=<slug> picks it.
import { prisma } from "./_brandDb.js";

const capFirst = (s: string) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);

async function main() {
  const conversions = await prisma.conversion.findMany({
    select: { id: true, agentConfig: true, user: { select: { email: true } } },
  });

  let updated = 0;
  for (const c of conversions) {
    const config = c.agentConfig as Record<string, any>;
    const scenarios = config?.rules?.scenarioHandling;
    if (!Array.isArray(scenarios) || scenarios.length === 0) continue;

    let changed = false;
    config.rules.scenarioHandling = scenarios.map((s: any) => {
      const ifText = capFirst(String(s.ifText ?? ""));
      const thenText = capFirst(String(s.thenText ?? ""));
      if (ifText !== s.ifText || thenText !== s.thenText) changed = true;
      return { ...s, ifText, thenText };
    });
    if (!changed) continue;

    await prisma.conversion.update({ where: { id: c.id }, data: { agentConfig: config } });
    updated++;
    console.log(`  ✓ ${c.user?.email ?? c.id}`);
  }

  console.log(`✅ ${updated}/${conversions.length} account configs capitalized.`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
