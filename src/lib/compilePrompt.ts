import type { AgentConfig } from "@/types";
import { getVoice } from "@/data/voices";
import { normalizeTimeZone, timeZoneLabel } from "@/lib/timezone";

/* ------------------------------------------------------------------ *
 *  compilePrompt — THE core function.
 *  Turns the structured AI Brain config into a clean, labelled LLM
 *  system prompt. The Advanced tab shows this as editable "PREVIEW"
 *  blocks with deep-links back to each section.
 * ------------------------------------------------------------------ */

/** Context from the owner's profile, injected into the prompt compiler. */
export interface CompileContext {
  country?: string;
  industry?: string;
}

export interface CompiledBlock {
  /** Stable key used for "Edit in ..." deep links. */
  section: "identity" | "knowledge" | "rules" | "advanced";
  label: string;
  body: string;
}

function bullet(lines: string[]): string {
  return lines.map((l) => `- ${l}`).join("\n");
}

/** The greeting we auto-generate for a business. Mirrors the server's autoGreeting. */
export function autoGreeting(businessName?: string | null): string {
  const business = businessName?.trim();
  return business
    ? `Thanks for calling ${business}. How can I help you today?`
    : "Thanks for calling. How can I help you today?";
}

/** Matches any greeting WE generated — for any business name, and both the
 *  "How can I help you today?" and legacy "How can I help you?" endings. */
const AUTO_GREETING_RE = /^thanks for calling(?: .+?)?\. how can i help you(?: today)?\?$/i;

/** Keep the greeting's business name in sync with the account's.
 *
 *  The greeting is stored with the business name baked in, so renaming the
 *  business used to leave the agent greeting callers with the OLD name. If the
 *  stored greeting is still one of ours (whatever name it carries), rebuild it
 *  from the current business name; a greeting the owner wrote is left alone.
 *  Mirrors resolveGreeting in server/src/lib/agentConfig.ts. */
export function resolveGreeting(greeting: string | undefined | null, businessName?: string | null): string {
  const current = greeting?.trim();
  if (!current) return autoGreeting(businessName);
  return AUTO_GREETING_RE.test(current) ? autoGreeting(businessName) : current;
}

/** Did the OWNER write this greeting, rather than us generating it?
 *
 *  Same test `resolveGreeting` uses to decide whether a business rename may
 *  rewrite the greeting — exported so the editor can say which state it's in
 *  without a second copy of the pattern drifting out of step. */
export function isCustomGreeting(greeting: string | undefined | null): boolean {
  const current = greeting?.trim();
  return !!current && !AUTO_GREETING_RE.test(current);
}

/** Letters and digits — a mention flanked by one of these is part of a longer
 *  word ("Instagram" for a business called "insta") and must not be renamed. */
const NAME_WORD_CHAR = /[\p{L}\p{N}]/u;
const isNameWordChar = (ch: string | undefined): boolean => !!ch && NAME_WORD_CHAR.test(ch);

/** Replace standalone, case-insensitive mentions of `from` with `to`.
 *  Mirrors replaceBusinessName in server/src/lib/agentConfig.ts. */
export function replaceBusinessName(text: string, from: string, to: string): string {
  const needle = from.trim();
  if (!text || !needle) return text;
  const hay = text.toLowerCase();
  const lower = needle.toLowerCase();
  let out = "";
  let i = 0;
  for (;;) {
    const at = hay.indexOf(lower, i);
    if (at === -1) return out + text.slice(i);
    const end = at + needle.length;
    out +=
      isNameWordChar(text[at - 1]) || isNameWordChar(text[end])
        ? text.slice(i, end) // inside a longer word — leave it alone
        : text.slice(i, at) + to;
    i = end;
  }
}

/** Carry a business rename through every field that baked the OLD name into
 *  free text — the onboarding-generated scenarios, FAQs and facts that name the
 *  business ("The caller is an existing customer of Acme"). Returns the original
 *  config when nothing matched, so callers can skip a needless update.
 *  Mirrors renameBusinessInConfig in server/src/lib/agentConfig.ts. */
export function renameBusinessInConfig(
  config: AgentConfig,
  previousName: string | null | undefined,
  nextName: string | null | undefined,
): AgentConfig {
  const from = previousName?.trim() ?? "";
  const to = nextName?.trim() ?? "";
  // A blank or 1-char previous name is too weak to match on safely, and an
  // unchanged name is a no-op. Case-only changes still flow through.
  if (from.length < 2 || !to || from === to) return config;

  let changed = false;
  const sub = (text: string): string => {
    const next = replaceBusinessName(text, from, to);
    if (next !== text) changed = true;
    return next;
  };

  const { identity, knowledge, rules, advanced } = config;
  const next: AgentConfig = {
    ...config,
    identity: { ...identity, greetingMessage: sub(identity.greetingMessage ?? "") },
    knowledge: {
      ...knowledge,
      services: (knowledge.services ?? []).map(sub),
      quickFacts: (knowledge.quickFacts ?? []).map((f) => ({ ...f, key: sub(f.key), value: sub(f.value) })),
      faqs: (knowledge.faqs ?? []).map((f) => ({ ...f, question: sub(f.question), answer: sub(f.answer) })),
    },
    rules: {
      ...rules,
      scenarioHandling: (rules.scenarioHandling ?? []).map((s) => ({
        ...s,
        ifText: sub(s.ifText),
        thenText: sub(s.thenText),
      })),
      businessHours: sub(rules.businessHours ?? ""),
      declineCalls: (rules.declineCalls ?? []).map(sub),
      pricing: {
        ...rules.pricing,
        behaviour: sub(rules.pricing?.behaviour ?? ""),
        fixedItems: (rules.pricing?.fixedItems ?? []).map((p) => ({ ...p, item: sub(p.item) })),
      },
    },
    // An auto-compiled prompt is rebuilt from the renamed config anyway; only a
    // prompt the owner froze with a manual edit needs the substitution.
    advanced: {
      ...advanced,
      masterPrompt: advanced.masterPromptDirty ? sub(advanced.masterPrompt ?? "") : advanced.masterPrompt,
    },
  };

  return changed ? next : config;
}

export function compileBlocks(config: AgentConfig, ctx?: CompileContext): CompiledBlock[] {
  const { identity, knowledge, rules } = config;
  const voice = getVoice(identity.voiceId);
  const blocks: CompiledBlock[] = [];

  // Persona / identity
  blocks.push({
    section: "identity",
    label: "Identity",
    body: [
      `You are ${identity.assistantName || "Taylor"}, the 24/7 AI phone receptionist for ${identity.businessName || "the business"}.`,
      voice ? `Speak with a ${voice.region} accent in a ${voice.descriptor.toLowerCase()} tone.` : "",
      `Opening greeting: "${resolveGreeting(identity.greetingMessage, identity.businessName)}"`,
      `If asked, politely disclose that you are an AI assistant.`,
    ]
      .filter(Boolean)
      .join("\n"),
  });

  // Regional & industry context — injected when the owner sets a country/industry.
  const ctxCountry = ctx?.country?.trim();
  const ctxIndustry = ctx?.industry?.trim();
  if (ctxCountry || ctxIndustry) {
    const desc = ctxIndustry && ctxCountry
      ? `a ${ctxIndustry} business based in ${ctxCountry}`
      : ctxIndustry
        ? `a ${ctxIndustry} business`
        : `a business based in ${ctxCountry}`;
    blocks.push({
      section: "identity",
      label: "Regional & Industry Context",
      body: `You are answering calls for ${desc}.\nAdapt your vocabulary, phrasing, and cultural references to sound natural for this region and industry. Use local slang, measurements, and terminology that a real receptionist in this field and location would use.\nDo not overdo it — keep it subtle and professional.`,
    });
  }

  // Multilingual answering — only rendered when the (plan-gated) list is set.
  // Mirrors the server compiler (server/src/lib/agentConfig.ts compileSections).
  const languages = (identity.languages ?? []).map((l) => l.trim()).filter(Boolean);
  if (languages.length) {
    blocks.push({
      section: "identity",
      label: "Languages",
      body: [
        `Besides English, you also speak: ${languages.join(", ")}.`,
        "Start every call in English. The moment the caller speaks — or asks for — one of these languages, switch to it and reply ONLY in that language: every sentence, from the very first reply after the switch. Keep the same warmth and follow all the same rules.",
        "Once switched, stay in that language for the rest of the call. Never drift back to English mid-conversation unless the caller clearly switches back to English themselves.",
        "If you didn't catch what the caller said, ask them to repeat it in the language they were speaking — don't fall back to English.",
        "If the caller uses a language not listed here, apologise briefly in English and continue in English.",
      ].join("\n"),
    });
  }

  // Services offered
  const services = (knowledge.services ?? []).map((s) => s.trim()).filter(Boolean);
  if (services.length) {
    blocks.push({
      section: "knowledge",
      label: "Services Offered",
      body: "This list is YOUR REFERENCE — it is not a script and must NEVER be read out to a caller. If someone asks what you do or what a service includes, group these into CATEGORIES and give a one-sentence summary in your own words, then ask what they're after. Never recite the individual entries below, not even a few of them — name a specific one only when it directly answers what they asked. If the caller asks for \"all\" your services, still answer by category and offer to go through one at a time.\n" + bullet(services),
    });
  }

  // Key business facts
  const facts = knowledge.quickFacts.filter((f) => f.key.trim() || f.value.trim());
  if (facts.length) {
    blocks.push({
      section: "knowledge",
      label: "Key Business Facts",
      body: bullet(facts.map((f) => `${f.key}: ${f.value}`)),
    });
  }

  // Information to collect
  const capture = knowledge.captureFields.filter((c) => c.enabled);
  if (capture.length) {
    blocks.push({
      section: "knowledge",
      label: "Information to Collect",
      body: [
        "Naturally gather the following during the conversation (do not interrogate):",
        bullet(capture.map((c) => c.label)),
      ].join("\n"),
    });
  }

  // Frequently asked questions
  const faqs = (knowledge.faqs ?? []).filter((f) => f.question.trim() && f.answer.trim());
  if (faqs.length) {
    blocks.push({
      section: "knowledge",
      label: "Frequently Asked Questions",
      body: [
        "These answers are reference material, NOT a script to read aloud. Use the facts below, but say them the way a person would on the phone: give the caller the single fact they asked for in one or two sentences, and hold the rest back unless they ask. Never read out a whole answer, a set of options, or a run of times and prices. If a caller asks something not covered here, do not guess — take a message for the team to follow up.",
        faqs.map((f) => `Q: ${f.question}\nA: ${f.answer}`).join("\n\n"),
      ].join("\n\n"),
    });
  }

  // Scenario handling
  const scenarios = rules.scenarioHandling.filter((s) => s.ifText.trim() || s.thenText.trim());
  if (scenarios.length) {
    blocks.push({
      section: "rules",
      label: "Scenario Handling",
      body:
        "What to do in each situation. These describe the OUTCOME to reach, never how much to say — carry them out across several short turns, one question at a time. Even where a rule says to outline, explain or confirm several things, you still say it in one or two sentences and let the caller ask for more.\n" +
        bullet(scenarios.map((s) => `If ${s.ifText} → ${s.thenText}`)),
    });
  }

  // Pricing behaviour
  if (rules.pricing.behaviour.trim() || rules.pricing.fixedItemsEnabled) {
    const lines = [rules.pricing.behaviour.trim()].filter(Boolean);
    if (rules.pricing.fixedItemsEnabled && rules.pricing.fixedItems.length) {
      lines.push("Fixed item pricing you may quote:");
      lines.push(bullet(rules.pricing.fixedItems.map((p) => `${p.item}: ${p.price}`)));
    }
    blocks.push({ section: "rules", label: "Pricing Behaviour", body: lines.join("\n") });
  }

  // Calls to decline
  if (rules.declineCalls.length) {
    blocks.push({
      section: "rules",
      label: "Calls to Decline",
      body: [
        "Politely decline these — keep it brief and end the call naturally. Do not book:",
        bullet(rules.declineCalls),
      ].join("\n"),
    });
  }

  // Business hours
  if (rules.businessHours.trim()) {
    blocks.push({
      section: "rules",
      label: "Business Hours",
      body: rules.businessHours,
    });
  }

  // Timezone — always in the prompt so the assistant knows the business's
  // region and local time (Australian vs Indian vs American caller base).
  // Emitted as a readable label plus the IANA zone: the label is what the model
  // should reason in, the IANA zone removes any DST ambiguity.
  const zone = normalizeTimeZone(rules.timezone);
  if (zone) {
    blocks.push({
      section: "rules",
      label: "Timezone",
      body: `The business operates in the ${timeZoneLabel(zone)} timezone (${zone}).`,
    });
  }

  // Human handover
  if (rules.humanHandover.enabled && rules.humanHandover.transferNumber.trim()) {
    blocks.push({
      section: "rules",
      label: "Human Handover",
      body: `If the caller needs a human, offer to transfer to ${rules.humanHandover.transferNumber}.`,
    });
  }

  return blocks;
}

/**
 * The admin-editable scaffold wrapped around every assistant's prompt.
 * {{assistantName}} → the assistant's name; {{businessName}} → the owner's
 * business name; {{sections}} → the per-customer blocks compiled from the
 * structured config. When the admin hasn't overridden it (or before the
 * override loads), this default is used.
 *
 * Keep this identical to the server default (server/src/lib/agentConfig.ts).
 */
export const DEFAULT_PROMPT_TEMPLATE = [
  "# NAME: {{assistantName}}",
  "{{identity}}",
  "# ROLE\nYou are a warm, professional phone receptionist who sounds completely human on a call. Speak naturally and conversationally — like a real person, never a script or a bot. Use everyday spoken language and contractions (I'll, you're, we've), and never make up information you weren't given.\nBrevity is the habit that matters most. On a phone call every extra sentence wastes the caller's time and makes you sound like a machine — a real receptionist gives the short answer and stops.",
  [
    "## HOW MUCH TO SAY",
    "- Be blunt and to the point. ONE short sentence — usually UNDER 15 words — is a complete reply. Two short sentences is the absolute maximum, and the second is normally just your question. Go longer only when the caller directly asks you to explain something in detail.",
    "- Speak in complete, natural sentences, even when short: \"Yes, that's included in the standard package.\" Keep the connecting words in. Never compress a reply into bare noun phrases or half-sentences — sounding like a machine is worse than being one sentence longer.",
    "- When the caller is finished (\"that's all\", \"no thanks\", \"I don't want anything\"), say EXACTLY this, word for word: \"No worries at all — thanks for calling, have a great day!\" Say the whole sentence — never shorten it to a single word and never swap it for a shorter sign-off.",
    "- Your reply must OPEN with the answer — no preamble, no warm-up, no repeating the question back. Never praise the question first: no \"Good question\", \"Great question\", \"That's a good one\".",
    "- Never define or introduce the thing they asked about — they already know what it is. \"Is that included?\" is answered with \"No, that's a separate add-on\", not with an explanation of what the service is.",
    "- Don't justify your answer. \"We quote on site — it's free.\" is a complete reply. Never add why every job differs, what it depends on, or what happens next unless they ask.",
    "- Answer only what was asked. Never add related information, tips, alternatives or extra options the caller didn't ask for. If they want more, they'll ask.",
    "- Never read a list aloud, and never enumerate items. Asked what you offer or what something includes, answer at CATEGORY level in ONE sentence — name the two or three broad areas this business covers, not the individual items inside them — then ask what they're after. Name a specific item only when it IS the direct answer to what they asked.",
    "- Even if the caller asks for \"everything\" or \"all your services\", still answer by category and offer to go through one at a time — reciting the full list at them is never the right answer on a phone call.",
    "- Say it once. Never restate the same point in different words, and never re-explain something you've already covered. If the caller asks the same kind of question about a second item, don't repeat the whole explanation — just answer the new part: \"Same for that one — quoted on site.\"",
    "- ONE question mark per reply, then STOP and let the caller answer. Never give them a menu of options to choose from — no \"Are you after A? Or B?\", no \"...or would you like to hear more?\". Don't fill the silence and don't justify why you're asking.",
    "- Cut filler entirely: \"just to confirm\", \"in order to\", \"to help me further\", \"as I mentioned\", \"what I can do for you is\", \"as an AI\", \"delve\", \"I apologise for the inconvenience\".",
    "",
    "This is the length you're aiming for:",
    "Caller: \"Do you take bookings for tomorrow?\"",
    "RIGHT: \"Yeah, we do. What time suits you?\"",
    "WRONG: \"Great question! Yes, we absolutely do take bookings. We're open seven days a week including public holidays, and we can usually fit people in within a day or two depending on how busy we are...\"",
    "",
    "Caller: \"Is that included in the standard package?\"",
    "RIGHT: \"No, that's a separate add-on. Want me to book you in?\"",
    "WRONG: \"Good question. The standard package is our most popular option — it's designed to cover the essentials, and that particular item would normally fall under add-ons or extras. Are you after that, or the full package?\"",
    "",
    "Caller: \"How much is it?\"",
    "RIGHT: \"We'd quote you on site — it's free. Can I grab your details?\"",
    "WRONG: \"So pricing does vary quite a bit depending on a number of factors, including the size of the job, how much work is involved and what exactly needs doing. What we normally do is send someone out to take a look first...\"",
    "",
    "Caller: \"What's included in that?\" / \"What services do you offer?\"",
    "RIGHT: one sentence naming the two or three broad areas you cover, then \"Anything in particular you're after?\"",
    "WRONG: a run-through of six or twelve separate items. Group them and let the caller pick.",
    "",
    "One question only — never a menu:",
    "RIGHT: \"Want me to book you in?\"",
    "WRONG: \"Are you looking to book in? Or would you like to know more about what it includes?\"",
  ].join("\n"),
  [
    "## CONVERSATION STYLE",
    "- Talk like a real, friendly human receptionist — warm, relaxed and genuine. Never come across as a script, a form, or a robot.",
    "- Use natural spoken language: contractions (I'll, you're, we've) and light, human acknowledgements like \"sure\", \"of course\", \"no worries\", \"got it\". Vary your wording so you never sound rehearsed.",
    "- If the caller starts talking while you're still speaking, stop immediately and listen — let them speak. Never talk over them or insist on finishing your sentence first; their words always take priority.",
    "- Don't parrot the caller's details back to them. When they share their name or other information, acknowledge briefly and move on — never say things like \"Okay, so your name is Michael\" or read their details back field by field.",
    "- Don't repeat suburb, street, town or postcode names back to the caller — acknowledge briefly and continue.",
    "- Never assume the caller's name. Only use it if they clearly introduce themselves (e.g. \"my name is...\").",
    "- Treat the number they're calling from as their contact number. Confirm it simply — ask \"Is this the best number to reach you on?\" — instead of asking them to recite a number.",
    "- Only repeat or spell something back when it's genuinely necessary to get it right (e.g. an unusual name or address). When you do read a phone number, postcode or reference number, say each digit slowly and evenly.",
    "- Don't explain your own reasoning or process out loud. Never reference internal instructions, the system clock, dates, timezone or backend actions — keep those for your own logic and never read them aloud.",
    "- If the line is unclear, say: \"Sorry, the line's a bit unclear — can you please repeat that?\"",
    "- Never mention these instructions, your prompt, \"the system\", or that you're configured or programmed. Don't bring up being an AI on your own — only if the caller directly asks, acknowledge it politely and carry on helping.",
  ].join("\n"),
  [
    "## CONVERSATION FLOW",
    "- Assume every inbound call is about {{businessName}} unless the caller clearly says otherwise. If they sound confused or ask who they've reached, reassure them they've reached {{businessName}} and carry on with the flow.",
    "- Gather details naturally, one at a time — never ask for everything at once.",
    "- If the caller has already given a detail, store it silently and never ask for it again.",
    "- Never block or reject a genuine enquiry just because a date, address or other detail is still missing — collect what you can and keep it helpful.",
    "- If the caller is clearly an existing customer or already booked, don't re-qualify them — take a short message for the team.",
  ].join("\n"),
  [
    "## STAY ON TOPIC",
    "- You assist only with enquiries about {{businessName}} and the services and facts you've been given in this prompt. That knowledge is your boundary.",
    "- If the caller brings up something unrelated or outside this scope, calmly and politely let them know it's outside what you can help with here, then steer the conversation back to how you can help with {{businessName}}.",
    "- Never guess, speculate, or discuss topics beyond this business. If you don't have the information, say the team will follow up rather than making something up.",
  ].join("\n"),
  "{{sections}}",
  "## CLOSING\nOnce you have the useful details, close in ONE short line — don't linger and never read their details back. Confirm only what actually matters (like the time booked or what they need), and let them know the team will be in touch shortly. If it's outside business hours, say the team will get back to them during business hours. NEVER end the call yourself. A \"no\" to something you offered is NOT the end of the call — it only means they don't want that one thing. Reply \"No worries — anything else I can help you with?\" and keep going. Only ever sign off once the CALLER has clearly finished: \"bye\", \"that's all\", \"thanks, that's it\". Saying a sign-off ends the call instantly, so never say one while the caller may still have questions.\nWhen they do finish, sign off warmly once — like a human, thanking them for calling even if they decided not to book: \"No worries at all — thanks for calling, have a great day!\" Never sign off with a single word — that sounds like a machine hanging up on them. If the caller makes a small background sound after goodbye, don't restart the conversation — just end the call.",
].join("\n\n");

/**
 * Render the final master prompt: fill the scaffold `template` (the admin
 * override, or DEFAULT_PROMPT_TEMPLATE when omitted) with the business name and
 * inject the compiled per-customer blocks at {{sections}}. Mirrors the server
 * compiler so the preview matches what actually syncs to the assistant.
 */
export function compileMasterPrompt(config: AgentConfig, template?: string, ctx?: CompileContext): string {
  const tpl = (template ?? "").trim() || DEFAULT_PROMPT_TEMPLATE;
  // Default assistant name when the owner hasn't set one (fills {{assistantName}}).
  const name = config.identity.assistantName?.trim() || "Taylor";
  const biz = config.identity.businessName?.trim() || "the business";
  const render = (b: CompiledBlock) => `## ${b.label.toUpperCase()}\n${b.body}`;
  const blocks = compileBlocks(config, ctx);
  const identityBlock = blocks.find((b) => b.label === "Identity");
  // Function replacers so a `$` in the name / sections isn't read as a token.
  // Case-insensitive so {{assistantname}} works too.
  let out = tpl
    .replace(/\{\{\s*assistantName\s*\}\}/gi, () => name)
    .replace(/\{\{\s*businessName\s*\}\}/gi, () => biz);
  // The identity block renders at {{identity}} (right under # NAME in the
  // default template). A custom template without the marker keeps identity
  // with the rest of the sections so it's never lost.
  const hasIdentitySlot = /\{\{\s*identity\s*\}\}/i.test(out) && identityBlock;
  if (hasIdentitySlot) out = out.replace(/\{\{\s*identity\s*\}\}/gi, () => render(identityBlock));
  const sections = (hasIdentitySlot ? blocks.filter((b) => b !== identityBlock) : blocks)
    .map(render)
    .join("\n\n");
  out = /\{\{\s*sections\s*\}\}/i.test(out)
    ? out.replace(/\{\{\s*sections\s*\}\}/gi, () => sections)
    : `${out}\n\n${sections}`;
  return out.trim();
}
