import "dotenv/config";
// A brand's workspace lives in the brand's database (phase 6): BRAND=<slug> picks it.
import { prisma } from "./_brandDb.js";
import { loadSettings, getPromptTemplate } from "../src/services/settings.js";
import {
  compileMasterPrompt,
  resolveGreeting,
  type AgentConfig,
  type CompileContext,
} from "../src/lib/agentConfig.js";
import { upsertAssistant } from "../src/services/vapi.js";

// One-off: re-derive auto-generated greetings still carrying a previous business name, recompile and
// push to Vapi. Owner-written greetings are never touched. Flags: --dry-run, --skip-sync.

const DRY_RUN = process.argv.includes("--dry-run");
const SKIP_SYNC = process.argv.includes("--skip-sync");

await loadSettings(); // hydrate the prompt template + Vapi key from DB/env

const conversions = await prisma.conversion.findMany({
  select: { id: true, userId: true, agentConfig: true, promptTemplateSnapshot: true, vapiAssistantId: true },
});

console.log(`Scanning ${conversions.length} agent config(s)${DRY_RUN ? " (dry run)" : ""}…`);

let healed = 0;
let synced = 0;
let failed = 0;

for (const conversion of conversions) {
  const config = conversion.agentConfig as unknown as AgentConfig;
  const identity = config?.identity;
  if (!identity) continue;

  const current = identity.greetingMessage ?? "";
  const next = resolveGreeting(current, identity.businessName);
  if (next === current) continue;

  healed++;
  console.log(`\n${conversion.userId}`);
  console.log(`  before: ${current || "(empty)"}`);
  console.log(`  after:  ${next}`);
  if (DRY_RUN) continue;

  identity.greetingMessage = next;

  // Keep the master prompt in step — unless the owner froze it with a manual
  // edit, in which case their text is theirs to fix.
  if (!config.advanced?.masterPromptDirty) {
    const profile = await prisma.profile.findUnique({
      where: { userId: conversion.userId },
      select: { country: true, industry: true },
    });
    const ctx: CompileContext = {
      country: profile?.country || undefined,
      industry: profile?.industry || undefined,
    };
    config.advanced.masterPrompt = compileMasterPrompt(
      config,
      conversion.promptTemplateSnapshot ?? getPromptTemplate(),
      ctx,
    );
  }

  await prisma.conversion.update({
    where: { id: conversion.id },
    data: { agentConfig: config as object },
  });

  // Push to the live assistant so the correction reaches real calls without
  // waiting for the owner's next AI-Brain save.
  if (!SKIP_SYNC && conversion.vapiAssistantId) {
    try {
      await upsertAssistant(config, conversion.vapiAssistantId, { ownerId: conversion.userId });
      synced++;
    } catch (err) {
      failed++;
      console.error(`  ! live sync failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

console.log(
  `\nDone — ${healed} greeting(s) ${DRY_RUN ? "would be healed" : "healed"}, ${synced} assistant(s) re-synced${
    failed ? `, ${failed} sync failure(s)` : ""
  }.`,
);
await prisma.$disconnect();
