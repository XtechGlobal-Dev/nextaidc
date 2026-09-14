import "dotenv/config";
import { loadSettings, getEffective } from "../src/services/settings.js";
import { buildVapiSystemPrompt, buildAssistantPayload } from "../src/services/vapi.js";
import type { AgentConfig } from "../src/lib/agentConfig.js";

// READ-ONLY: dump the prompt an agent runs on and which anti-rambling rules survived the summarizer. TEST CALL is
// compiled fresh per call; LIVE ASSISTANT is stored on Vapi and stale until a save/resync. No argument lists accounts.

// A brand's workspace lives in the brand's database (phase 6): BRAND=<slug> picks it.
import { prisma } from "./_brandDb.js";
const EMAIL = process.argv[2];

/** Each rule we deliberately put in the prompt, and how to spot it. */
const CHECKS: [label: string, present: (p: string) => boolean][] = [
  ["## HOW MUCH TO SAY heading", (p) => /HOW MUCH TO SAY/i.test(p)],
  ["hard length limit (under 15 words / one sentence)", (p) => /15 words|ONE short sentence/i.test(p)],
  ['open with the answer (no "Good question")', (p) => /Good question/i.test(p)],
  ["no defining what they asked about", (p) => /define or introduce/i.test(p)],
  ["no justifying the answer", (p) => /justify your answer/i.test(p)],
  ["ONE question mark per reply (no menu)", (p) => /ONE question mark|menu of options|never a menu/i.test(p)],
  ["worked examples (Caller: / RIGHT: / WRONG:)", (p) => /Caller:\s*"/.test(p) && /(WRONG:|NOT a run-through)/.test(p)],
  ["never read a list aloud", (p) => /never read a list|read a list aloud|enumerate/i.test(p)],
  ["CATEGORY-level answering rule", (p) => /CATEGORY|categor/i.test(p)],
  ["services list = reference, not a script", (p) => /YOUR REFERENCE|not a script|NEVER be read out/i.test(p)],
  ["FAQ = reference material, not read aloud", (p) => /reference material/i.test(p)],
  ["scenario preamble (outcome, not how much to say)", (p) => /OUTCOME to reach|never how much to say/i.test(p)],
  ["complete sentences, not fragments", (p) => /complete, natural sentences|bare noun phrases/i.test(p)],
  ["exact warm sign-off sentence", (p) => /have a great day/i.test(p)],
  ["one-word sign-off banned", (p) => /one-word sign-off|single word/i.test(p)],
  ["never end the call yourself", (p) => /NEVER end the call yourself|not the end of the call/i.test(p)],
];

function report(title: string, prompt: string, note?: string): void {
  console.log(`\n=== ${title} — ${prompt.length} chars`);
  if (note) console.log(`    ${note}`);
  let kept = 0;
  for (const [label, present] of CHECKS) {
    const ok = present(prompt);
    if (ok) kept++;
    console.log(`  ${ok ? "KEPT    " : "STRIPPED"}  ${label}`);
  }
  console.log(`  --> ${kept}/${CHECKS.length} rules survived`);
}

async function main() {
  await loadSettings();

  if (!EMAIL) {
    const all = await prisma.conversion.findMany({
      select: { vapiAssistantId: true, updatedAt: true, user: { select: { email: true } } },
      orderBy: { updatedAt: "desc" },
    });
    console.log("Pass an account email. Accounts (most recently saved first):\n");
    for (const a of all) {
      console.log(`  ${a.user.email}${a.vapiAssistantId ? "" : "   (no assistant yet — test call only)"}`);
    }
    return;
  }

  const c = await prisma.conversion.findFirst({
    where: { user: { email: EMAIL } },
    select: { vapiAssistantId: true, agentConfig: true, updatedAt: true, userId: true },
  });
  if (!c) {
    console.log(`No account found for ${EMAIL}. Run with no argument to list accounts.`);
    return;
  }
  const cfg = c.agentConfig as unknown as AgentConfig;
  console.log(`account: ${EMAIL}   config saved: ${c.updatedAt.toISOString()}`);

  // 1. Test call prompt. buildAssistantPayload grafts on ENDING THE CALL and the tool blocks, so
  //    checking buildVapiSystemPrompt alone misses them.
  const wire = await buildVapiSystemPrompt(cfg, c.userId);
  const payload = buildAssistantPayload(cfg, { systemPrompt: wire });
  const testPrompt = (payload.model.messages[0] as { content: string }).content;
  report(
    "TEST CALL (browser Test call button)",
    testPrompt,
    "Compiled fresh from the deployed code on every call — no save or resync needed.",
  );
  console.log(`  endCallPhrases sent: ${(payload.endCallPhrases ?? []).join(", ") || "(none)"}`);
  const ending = /## ENDING THE CALL[\s\S]*?(?=\n## |$)/.exec(testPrompt);
  console.log("\n----- ENDING THE CALL, as the agent receives it -----");
  console.log(ending ? ending[0] : "(BLOCK MISSING — allowHangUp off, or it never got grafted)");

  // 2. What a real inbound phone call uses — only once provisioned.
  if (!c.vapiAssistantId) {
    console.log("\n=== LIVE ASSISTANT — none yet");
    console.log("    No Vapi assistant (no number assigned), so real phone calls aren't possible yet.");
    console.log("    The TEST CALL prompt above is the one being exercised.");
  } else {
    const vapiKey = getEffective("vapi.apiKey");
    const res = await fetch(`https://api.vapi.ai/assistant/${c.vapiAssistantId}`, {
      headers: { Authorization: `Bearer ${vapiKey}` },
    });
    if (!res.ok) {
      console.log(`\n=== LIVE ASSISTANT — fetch failed, HTTP ${res.status} (deleted/stale id?)`);
    } else {
      const live = (await res.json()) as Record<string, any>;
      const p: string = live?.model?.messages?.find((m: any) => m.role === "system")?.content ?? "";
      report(
        "LIVE ASSISTANT (real inbound phone calls)",
        p,
        "Stored on Vapi at the last push — stale until a Save Changes or scripts/resyncAgents.ts.",
      );
    }
  }

  console.log("\n----- TEST CALL PROMPT (first 2600 chars) -----");
  console.log(testPrompt.slice(0, 2600));
}

main().finally(() => prisma.$disconnect());
