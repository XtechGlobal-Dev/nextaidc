import { describe, it, expect } from "vitest";
import {
  WIRE_BEHAVIOUR_RULES,
  WIRE_NUMBER_RULES,
  stripHowMuchToSay,
  DEFAULT_PROMPT_TEMPLATE_SHORT,
} from "./agentConfig.js";

/* The call-behaviour rules are appended to every wire prompt in
 * buildVapiSystemPrompt, which is the only reason they reach an agent whose
 * owner froze their master prompt with a manual edit. These lock down the
 * pieces that makes that safe: the block is self-contained, and any earlier
 * copy is removable so the two can't contradict each other. */

describe("WIRE_BEHAVIOUR_RULES", () => {
  it("carries the rules the agent regresses on the moment they're softened", () => {
    expect(WIRE_BEHAVIOUR_RULES).toMatch(/^## HOW MUCH TO SAY/);
    expect(WIRE_BEHAVIOUR_RULES).toMatch(/UNDER 15 words/);
    expect(WIRE_BEHAVIOUR_RULES).toMatch(/ONE question mark per reply/);
    expect(WIRE_BEHAVIOUR_RULES).toMatch(/complete, natural sentences/);
    expect(WIRE_BEHAVIOUR_RULES).toMatch(/have a great day/);
  });

  it("is embedded in the short scaffold, so the two can never drift apart", () => {
    expect(DEFAULT_PROMPT_TEMPLATE_SHORT).toContain(WIRE_BEHAVIOUR_RULES);
  });
});

/* Callers read a phone number out in groups. Everything here exists because the
 * agent used to answer the first group as if it were the whole number and then
 * ask for it again — see the transcriber side in services/vapi.ts. */
describe("WIRE_NUMBER_RULES", () => {
  it("tells the agent a short digit run is an unfinished number, not an answer", () => {
    expect(WIRE_NUMBER_RULES).toMatch(/^## TAKING A NUMBER/);
    expect(WIRE_NUMBER_RULES).toMatch(/wait for the rest/i);
    expect(WIRE_NUMBER_RULES).toMatch(/nine to eleven digits/i);
    expect(WIRE_NUMBER_RULES).toMatch(/never ask them to start the number again/i);
    expect(WIRE_NUMBER_RULES).toMatch(/digits, never as words/i);
  });

  it("names no single country's numbering plan", () => {
    // The same rules ship to AU, US and UK agents — a hardcoded national digit
    // count would be wrong for most of them.
    expect(WIRE_NUMBER_RULES).not.toMatch(/australian|american|british|\bUK\b|\bUS\b/i);
  });

  it("stays OUT of the editable scaffold, unlike the behaviour rules", () => {
    // Deliberate: this block is wire-only, so it can never be frozen into a
    // customer's master prompt, reworded by the summarizer, or drift from the
    // transcriber settings it partners with.
    expect(DEFAULT_PROMPT_TEMPLATE_SHORT).not.toContain(WIRE_NUMBER_RULES);
    expect(DEFAULT_PROMPT_TEMPLATE_SHORT).not.toMatch(/## TAKING A NUMBER/);
  });

  it("survives the strip that runs before both blocks are appended", () => {
    // buildVapiSystemPrompt composes exactly this. The strip targets HOW MUCH TO
    // SAY; it must stop at the next heading and leave the number rules whole.
    const wire = `${stripHowMuchToSay("# ROLE\nBe brief.")}\n\n${WIRE_BEHAVIOUR_RULES}\n\n${WIRE_NUMBER_RULES}`;
    expect(stripHowMuchToSay(wire)).toMatch(/## TAKING A NUMBER/);
    expect(stripHowMuchToSay(wire)).toMatch(/digits, never as words/i);
  });
});

describe("stripHowMuchToSay", () => {
  it("removes the section the compiled scaffold already carries", () => {
    const compiled = DEFAULT_PROMPT_TEMPLATE_SHORT;
    const stripped = stripHowMuchToSay(compiled);
    expect(stripped).not.toMatch(/HOW MUCH TO SAY/);
    // Everything either side of it survives.
    expect(stripped).toMatch(/# ROLE/);
    expect(stripped).toMatch(/## CONVERSATION STYLE/);
    expect(stripped).toMatch(/## CLOSING/);
  });

  it("removes a summarizer-reworded copy too, so only one set of rules survives", () => {
    const reworded = [
      "# ROLE\nBe brief.",
      "## HOW MUCH TO SAY\n- Keep replies short.\n- Ask one thing.",
      "## CONVERSATION STYLE\n- Sound human.",
    ].join("\n\n");
    const out = `${stripHowMuchToSay(reworded)}\n\n${WIRE_BEHAVIOUR_RULES}`;
    expect(out.match(/## HOW MUCH TO SAY/g)).toHaveLength(1);
    expect(out).not.toMatch(/Keep replies short/);
    expect(out).toMatch(/UNDER 15 words/);
  });

  it("handles the section appearing last, with no heading after it", () => {
    const tail = "# ROLE\nBe brief.\n\n## HOW MUCH TO SAY\n- Keep it short.";
    expect(stripHowMuchToSay(tail)).toBe("# ROLE\nBe brief.");
  });

  it("leaves a prompt that never had the section untouched", () => {
    const prompt = "# ROLE\nBe brief.\n\n## CLOSING\nSay bye once.";
    expect(stripHowMuchToSay(prompt)).toBe(prompt);
  });

  it("does not eat a following section when headings sit next to each other", () => {
    const p = "## HOW MUCH TO SAY\n- Short.\n## CLOSING\nBye.";
    expect(stripHowMuchToSay(p)).toBe("## CLOSING\nBye.");
  });
});
