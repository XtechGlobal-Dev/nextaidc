import "dotenv/config";
import { loadSettings } from "../src/services/settings.js";
import { upsertAssistant } from "../src/services/vapi.js";
import type { AgentConfig } from "../src/lib/agentConfig.js";

// Push every agent's saved config to its live Vapi assistant (a bulk "Save Changes"). Use after a sync
// failure left stale prompts live.

// A brand's workspace lives in the brand's database (phase 6): BRAND=<slug> picks it.
import { prisma } from "./_brandDb.js";

async function main() {
  await loadSettings();
  const conversions = await prisma.conversion.findMany({
    where: { vapiAssistantId: { not: null } },
    select: {
      id: true,
      // Required: without an owner the payload sends empty `tools` and STRIPS transfer/booking/SMS from the live assistant.
      userId: true,
      vapiAssistantId: true,
      agentConfig: true,
      user: { select: { email: true } },
    },
  });
  console.log(`Agents with a live assistant: ${conversions.length}\n`);

  for (const c of conversions) {
    const cfg = c.agentConfig as unknown as AgentConfig;
    if (!cfg?.identity) {
      console.log(`- ${c.user.email}: no agentConfig, skipped`);
      continue;
    }
    try {
      const id = await upsertAssistant(cfg, c.vapiAssistantId, { ownerId: c.userId });
      if (id && id !== c.vapiAssistantId) {
        await prisma.conversion.update({ where: { id: c.id }, data: { vapiAssistantId: id } });
        console.log(`- ${c.user.email}: RE-CREATED (old assistant was gone) → ${id}`);
      } else {
        console.log(`- ${c.user.email}: synced OK`);
      }
    } catch (e) {
      console.log(`- ${c.user.email}: FAILED — ${e instanceof Error ? e.message : e}`);
    }
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
