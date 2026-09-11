import { describe, it, expect } from "vitest";
import { END_CALL_PHRASES, stripDontHangUpFirst, endCallPromptSection } from "./vapi.js";
import { DEFAULT_PROMPT_TEMPLATE, WIRE_BEHAVIOUR_RULES } from "../lib/agentConfig.js";

describe("stripDontHangUpFirst", () => {
  it("removes the sentence that contradicts the ENDING THE CALL block", () => {
    const closing =
      "Close promptly. Don't hang up first — wait for a clear end signal (like \"bye\") before signing off warmly, once. If the caller makes a small background sound after goodbye, don't restart the conversation.";
    const out = stripDontHangUpFirst(closing);
    expect(out).not.toMatch(/hang up first/i);
    // Everything either side of that one sentence survives.
    expect(out).toContain("Close promptly.");
    expect(out).toContain("don't restart the conversation.");
  });

  it("handles the colon wording and a typographic apostrophe", () => {
    expect(stripDontHangUpFirst("A. Don’t hang up first: wait for a clear goodbye. B.")).toBe("A. B.");
  });

  it("returns the prompt untouched when it never says it", () => {
    const prompt = "## CLOSING\nSign off warmly once the caller says goodbye.";
    expect(stripDontHangUpFirst(prompt)).toBe(prompt);
  });

  it("leaves the shipped template with nothing to strip", () => {
    expect(DEFAULT_PROMPT_TEMPLATE).not.toMatch(/hang up first/i);
  });
});

describe("the scripted sign-off must actually hang up", () => {
  /* The prompt names one exact sign-off sentence. If that wording isn't in
   * END_CALL_PHRASES it leaves the line open, and the agent falls back to a
   * bare "Goodbye." — the phrase here that does end the call. Keep the three
   * in step: WIRE_BEHAVIOUR_RULES, endCallPromptSection, END_CALL_PHRASES. */
  const scripted = "no worries at all — thanks for calling, have a great day!";

  it("ends the call on the sign-off the behaviour rules script", () => {
    expect(WIRE_BEHAVIOUR_RULES).toMatch(/have a great day/);
    expect(END_CALL_PHRASES.some((p) => scripted.includes(p))).toBe(true);
  });

  it("ends the call on the sign-off the ENDING THE CALL block scripts", () => {
    const section = endCallPromptSection();
    expect(section).toMatch(/have a great day/);
    expect(section).toMatch(/never shorten it to a single word/i);
  });

  /* Described sign-offs ("a warm sentence ending in X, e.g. …") got paraphrased
   * down to "Goodbye." on live calls, while the scripted "anything else I can
   * help you with?" line came back verbatim every time. Both places must give
   * the sentence as an exact script, not an example. */
  it("gives the sign-off as an exact script rather than an example", () => {
    for (const text of [endCallPromptSection(), WIRE_BEHAVIOUR_RULES]) {
      expect(text).toMatch(/EXACTLY this, word for word/);
      expect(text).toContain("No worries at all — thanks for calling, have a great day!");
      expect(text).not.toMatch(/e\.g\.\s*"No worries/);
    }
  });
});

describe("END_CALL_PHRASES", () => {
  it("covers the sign-offs the agent actually uses", () => {
    for (const phrase of ["goodbye", "take care", "have a great day", "have a nice day"]) {
      expect(END_CALL_PHRASES).toContain(phrase);
    }
  });

  it("excludes greeting wording so a call can't end at hello", () => {
    expect(END_CALL_PHRASES.some((p) => "thanks for calling acme. how can i help you today?".includes(p))).toBe(
      false,
    );
  });
});
