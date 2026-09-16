import "dotenv/config";
// A brand's workspace lives in the brand's database (phase 6): BRAND=<slug> picks it.
import { prisma } from "./_brandDb.js";
import { loadSettings, getPromptTemplate } from "../src/services/settings.js";
import {
  compileMasterPrompt,
  renameBusinessInConfig,
  type AgentConfig,
  type CompileContext,
} from "../src/lib/agentConfig.js";
import { upsertAssistant } from "../src/services/vapi.js";

// One-off heal: sweep a previous business name out of generated text (the config has lost it, so pass --from).
// npm run rename-business -- --from "Acme" [--to "Zenith"] [--user email|id] [--dry-run] [--skip-sync]

const argv = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const at = argv.indexOf(`--${name}`);
  return at === -1 ? undefined : argv[at + 1];
};
const DRY_RUN = argv.includes("--dry-run");
const SKIP_SYNC = argv.includes("--skip-sync");
const FROM = flag("from")?.trim();
const TO = flag("to")?.trim();
const USER = flag("user")?.trim();

if (!FROM) {
  console.error('Missing --from. Example: npm run rename-business -- --from "Acme" --user someone@example.com');
  process.exit(1);
}

await loadSettings(); // hydrate the prompt template + Vapi key from DB/env

let userId: string | undefined;
if (USER) {
  const user = await prisma.user.findFirst({
    where: { OR: [{ id: USER }, { email: USER.toLowerCase() }] },
    select: { id: true, email: true },
  });
  if (!user) {
    console.error(`No user matched "${USER}".`);
    process.exit(1);
  }
  userId = user.id;
  console.log(`Scoped to ${user.email} (${user.id}).`);
}

const conversions = await prisma.conversion.findMany({
  where: userId ? { userId } : undefined,
  select: { id: true, userId: true, agentConfig: true, promptTemplateSnapshot: true, vapiAssistantId: true },
});

console.log(`Scanning ${conversions.length} agent config(s)${DRY_RUN ? " (dry run)" : ""}…`);

let healed = 0;
let synced = 0;
let failed = 0;

for (const conversion of conversions) {
  const config = conversion.agentConfig as unknown as AgentConfig;
  if (!config?.identity) continue;

  const to = TO || (config.identity.businessName ?? "").trim();
  if (!to) continue;

  let next = renameBusinessInConfig(config, FROM, to);
  if (next === config) continue; // nothing named the old business

  healed++;
  console.log(`\n${conversion.userId}  ${FROM} → ${to}`);
  for (const s of next.rules.scenarioHandling ?? []) {
    if (s.ifText.includes(to) || s.thenText.includes(to)) console.log(`  scenario: If ${s.ifText} → ${s.thenText}`);
  }
  if (DRY_RUN) continue;

  // The name the config is stored under wins — a --to that differs means the
  // rename hadn't been made yet, so make it here too.
  next = { ...next, identity: { ...next.identity, businessName: to } };

  // Keep the master prompt in step — unless the owner froze it with a manual
  // edit, which renameBusinessInConfig already rewrote in place.
  if (!next.advanced?.masterPromptDirty) {
    const profile = await prisma.profile.findUnique({
      where: { userId: conversion.userId },
      select: { country: true, industry: true },
    });
    const ctx: CompileContext = {
      country: profile?.country || undefined,
      industry: profile?.industry || undefined,
    };
    next.advanced.masterPrompt = compileMasterPrompt(
      next,
      conversion.promptTemplateSnapshot ?? getPromptTemplate(),
      ctx,
    );
  }

  await prisma.conversion.update({
    where: { id: conversion.id },
    data: { agentConfig: next as object },
  });

  // Push to the live assistant so the correction reaches real calls without
  // waiting for the owner's next AI-Brain save.
  if (!SKIP_SYNC && conversion.vapiAssistantId) {
    try {
      await upsertAssistant(next, conversion.vapiAssistantId, { ownerId: conversion.userId });
      synced++;
    } catch (err) {
      failed++;
      console.error(`  ! live sync failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

console.log(
  `\nDone — ${healed} config(s) ${DRY_RUN ? "would be healed" : "healed"}, ${synced} assistant(s) re-synced${
    failed ? `, ${failed} sync failure(s)` : ""
  }.`,
);
await prisma.$disconnect();
