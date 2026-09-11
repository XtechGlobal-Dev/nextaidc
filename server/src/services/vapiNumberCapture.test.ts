import { describe, it, expect } from "vitest";
import { buildAssistantPayload } from "./vapi.js";
import { DEFAULT_AGENT_CONFIG, type AgentConfig } from "../lib/agentConfig.js";

/* Callers dictate a phone number in groups, with a pause between each. Two Vapi
 * defaults conspired to break that:
 *   - Deepgram writes spoken numbers as WORDS unless `numerals` is set, so the
 *     model received "eight five eight zero four" and had to reassemble it;
 *   - the number endpointing window is 0.5s, shorter than the pause people leave
 *     mid-number, so each group arrived as its own finished turn.
 * Together they produced the "sorry, can you repeat that?" loops owners heard.
 * Both settings are invisible until a real call, so they're pinned here. */

const config = (over: Partial<AgentConfig> = {}): AgentConfig => ({
  ...DEFAULT_AGENT_CONFIG,
  ...over,
});

const withLanguages = (languages: string[]): AgentConfig =>
  config({ identity: { ...DEFAULT_AGENT_CONFIG.identity, languages } });

describe("transcriber number handling", () => {
  it("asks Deepgram for digits, not words", () => {
    const t = buildAssistantPayload(config()).transcriber;
    expect(t?.provider).toBe("deepgram");
    expect(t?.numerals).toBe(true);
  });

  it("keeps smartFormat on — numerals replaces neither addresses nor dates", () => {
    // smartFormat alone does NOT produce digits (Deepgram's own note is that it
    // "can sometimes format numbers as times"), so the two are complementary and
    // dropping either one regresses a different part of the transcript.
    const t = buildAssistantPayload(config()).transcriber;
    expect(t?.smartFormat).toBe(true);
  });

  it("sets numerals for multilingual agents too, not just English", () => {
    // Deepgram supports numerals across most of the nova-3 multi set. Gating it
    // to "en" the way keyterm is gated would leave those callers reciting their
    // number twice.
    const t = buildAssistantPayload(withLanguages(["Spanish"])).transcriber;
    expect(t?.language).toBe("multi");
    expect(t?.numerals).toBe(true);
  });
});

describe("number endpointing", () => {
  it("waits longer than Vapi's 0.5s default before answering a turn that ends on a number", () => {
    const plan = buildAssistantPayload(config()).startSpeakingPlan;
    const wait = plan?.transcriptionEndpointingPlan?.onNumberSeconds;
    expect(wait).toBeGreaterThan(0.5);
  });

  it("leaves the non-number timings on Vapi's defaults, so ordinary replies stay snappy", () => {
    // Raising these too would slow down every turn in the call, not just the
    // one where a number is being read out.
    const p = buildAssistantPayload(config()).startSpeakingPlan?.transcriptionEndpointingPlan;
    expect(p?.onPunctuationSeconds).toBeUndefined();
    expect(p?.onNoPunctuationSeconds).toBeUndefined();
  });

  it("still yields the floor the instant the caller speaks", () => {
    // The longer number window must not be mistaken for slower barge-in — those
    // are separate plans and interrupting has to stay immediate.
    expect(buildAssistantPayload(config()).stopSpeakingPlan?.numWords).toBe(0);
  });
});
