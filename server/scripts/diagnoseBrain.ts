import "dotenv/config";
import { loadSettings, getEffective, getPromptTemplate } from "../src/services/settings.js";
import { compileMasterPrompt, type AgentConfig } from "../src/lib/agentConfig.js";

// READ-ONLY: compare each agent's stored config against the live Vapi prompt — do FAQs/scenarios/services
// actually reach the call? Prints no secrets.

// A brand's workspace lives in the brand's database (phase 6): BRAND=<slug> picks it.
import { prisma } from "./_brandDb.js";

function section(prompt: string, heading: string): boolean {
  return prompt.toUpperCase().includes(heading.toUpperCase());
}

/** First point where two strings diverge, with surrounding context. */
function firstDiff(a: string, b: string): string {
  const n = Math.min(a.length, b.length);
  let i = 0;
  while (i < n && a[i] === b[i]) i++;
  if (i === n && a.length === b.length) return "(identical)";
  const ctx = (s: string) => JSON.stringify(s.slice(Math.max(0, i - 60), i + 120));
  return `at char ${i}:\n      expected …${ctx(b)}…\n      live     …${ctx(a)}…`;
}

async function main() {
  await loadSettings();
  const vapiKey = getEffective("vapi.apiKey");
  const dbHost = (process.env.DATABASE_URL ?? "").replace(/^.*@/, "").split("/")[0];
  console.log(`DB host: ${dbHost || "(unknown)"}`);
  console.log(`Vapi key configured: ${vapiKey ? "YES" : "NO"}`);

  const conversions = await prisma.conversion.findMany({
    select: {
      status: true,
      vapiAssistantId: true,
      agentConfig: true,
      updatedAt: true,
      user: { select: { email: true, role: true } },
    },
    orderBy: { updatedAt: "desc" },
  });
  console.log(`\nTotal agents in DB: ${conversions.length}\n`);

  for (const c of conversions) {
    const cfg = c.agentConfig as unknown as AgentConfig;
    if (!cfg?.identity) {
      console.log(`--- ${c.user.email} — no agentConfig, skipping`);
      continue;
    }
    const rawFaqs = cfg.knowledge?.faqs ?? [];
    const faqs = rawFaqs.filter((f) => f.question?.trim() && f.answer?.trim());
    const incompleteFaqs = rawFaqs.length - faqs.length;
    if (incompleteFaqs > 0)
      console.log(
        `    !! ${incompleteFaqs} FAQ row(s) have an empty question or answer and are DROPPED from the prompt`,
      );
    const scenarios = (cfg.rules?.scenarioHandling ?? []).filter(
      (s) => s.ifText?.trim() || s.thenText?.trim(),
    );
    const services = (cfg.knowledge?.services ?? []).filter((s) => s?.trim());
    const dirty = Boolean(cfg.advanced?.masterPromptDirty);
    const stored = cfg.advanced?.masterPrompt ?? "";
    const expected = dirty ? stored : compileMasterPrompt(cfg, getPromptTemplate());

    console.log(`=== ${c.user.email} (${c.user.role}) — status ${c.status}, saved ${c.updatedAt.toISOString()}`);
    console.log(
      `    config: faqs=${faqs.length} scenarios=${scenarios.length} services=${services.length} masterPromptDirty=${dirty}`,
    );
    if (dirty) {
      console.log(
        `    !! prompt FROZEN (manually edited). Stored prompt has FAQ section: ${section(stored, "FREQUENTLY ASKED QUESTIONS")}, scenario section: ${section(stored, "SCENARIO HANDLING")}`,
      );
      if (faqs.length && !section(stored, "FREQUENTLY ASKED QUESTIONS"))
        console.log(`    !! ${faqs.length} FAQs exist in config but are MISSING from the frozen prompt`);
    }

    if (!c.vapiAssistantId) {
      console.log(`    no vapiAssistantId — agent never provisioned; nothing live to compare\n`);
      continue;
    }
    if (!vapiKey) {
      console.log(`    (skipping live check — no Vapi key)\n`);
      continue;
    }
    try {
      const res = await fetch(`https://api.vapi.ai/assistant/${c.vapiAssistantId}`, {
        headers: { Authorization: `Bearer ${vapiKey}` },
      });
      if (!res.ok) {
        console.log(`    LIVE: assistant fetch failed — HTTP ${res.status} (assistant deleted/stale id?)\n`);
        continue;
      }
      const live = (await res.json()) as Record<string, any>;
      const livePrompt: string = live?.model?.messages?.find((m: any) => m.role === "system")?.content ?? "";
      const liveModel = `${live?.model?.provider}/${live?.model?.model}`;
      console.log(`    LIVE: model=${liveModel} promptLen=${livePrompt.length} (expected ${expected.length})`);
      console.log(
        `    LIVE prompt sections: FAQ=${section(livePrompt, "FREQUENTLY ASKED QUESTIONS")} scenarios=${section(livePrompt, "SCENARIO HANDLING")} services=${section(livePrompt, "SERVICES OFFERED")} facts=${section(livePrompt, "KEY BUSINESS FACTS")}`,
      );
      const inSync = livePrompt.trim() === expected.trim();
      console.log(`    IN SYNC with saved config: ${inSync ? "YES" : "NO — live prompt differs from what the config compiles to"}`);
      if (!inSync) console.log(`    DIFF ${firstDiff(livePrompt.trim(), expected.trim())}`);
      if (!inSync && faqs.length && !section(livePrompt, "FREQUENTLY ASKED QUESTIONS")) {
        console.log(`    >>> ROOT CAUSE CANDIDATE: config has ${faqs.length} FAQs but live prompt has NO FAQ section`);
      }
    } catch (e) {
      console.log(`    LIVE: fetch error — ${e instanceof Error ? e.message : e}`);
    }
    console.log("");
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
