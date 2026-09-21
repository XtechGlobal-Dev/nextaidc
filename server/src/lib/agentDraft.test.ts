import { describe, it, expect } from "vitest";
import { stableJson, isFullConfig, draftDiffersFromSaved } from "./agentDraft.js";

// The gate on the test-call fast path. A false "unchanged" is the dangerous
// direction: the caller rings themselves to hear an edit and hears the old agent.

const SAVED = {
  identity: { assistantName: "Mark", businessName: "Acme", languages: ["en"] },
  knowledge: { faqs: [{ q: "Hours?", a: "9-5" }], services: ["Plumbing"] },
  rules: { scenarios: [] },
  advanced: { creativity: 0.4, allowHangUp: true, masterPromptDirty: false },
};

/** Same content, every object rebuilt with its keys in a different order —
 *  which is exactly what a browser POST vs a jsonb read gives you. */
const REORDERED = {
  advanced: { allowHangUp: true, masterPromptDirty: false, creativity: 0.4 },
  rules: { scenarios: [] },
  knowledge: { services: ["Plumbing"], faqs: [{ a: "9-5", q: "Hours?" }] },
  identity: { languages: ["en"], businessName: "Acme", assistantName: "Mark" },
};

describe("stableJson", () => {
  it("ignores key order", () => {
    expect(stableJson(SAVED)).toBe(stableJson(REORDERED));
  });

  it("does NOT ignore array order — a reordered FAQ list is a real edit", () => {
    expect(stableJson({ a: [1, 2] })).not.toBe(stableJson({ a: [2, 1] }));
  });

  it("treats an absent key and an explicit undefined as the same", () => {
    // Postgres drops undefined on the way in; the browser sends it. Neither is a change.
    expect(stableJson({ a: 1, b: undefined })).toBe(stableJson({ a: 1 }));
  });

  it("keeps null distinct from absent — null is a stored value", () => {
    expect(stableJson({ a: 1, b: null })).not.toBe(stableJson({ a: 1 }));
  });

  it("does not confuse a number with its string form", () => {
    expect(stableJson({ a: 1 })).not.toBe(stableJson({ a: "1" }));
  });
});

describe("isFullConfig", () => {
  it("accepts a config with all four sections", () => {
    expect(isFullConfig(SAVED)).toBe(true);
  });

  it.each([
    ["nothing", undefined],
    ["null", null],
    ["a string", "identity"],
    ["a partial config", { identity: {}, advanced: {} }],
  ])("rejects %s", (_label, value) => {
    expect(isFullConfig(value)).toBe(false);
  });
});

describe("draftDiffersFromSaved", () => {
  it("says no when there is no draft at all — dial the saved assistant", () => {
    expect(draftDiffersFromSaved(undefined, SAVED)).toBe(false);
  });

  it("says no for a draft that only differs by key order", () => {
    expect(draftDiffersFromSaved(REORDERED, SAVED)).toBe(false);
  });

  it("catches an edit to the greeting", () => {
    const draft = { ...SAVED, identity: { ...SAVED.identity, assistantName: "Jess" } };
    expect(draftDiffersFromSaved(draft, SAVED)).toBe(true);
  });

  it("catches an edit buried in the knowledge base", () => {
    const draft = { ...SAVED, knowledge: { ...SAVED.knowledge, faqs: [{ q: "Hours?", a: "8-6" }] } };
    expect(draftDiffersFromSaved(draft, SAVED)).toBe(true);
  });

  it("catches a removed service", () => {
    const draft = { ...SAVED, knowledge: { ...SAVED.knowledge, services: [] } };
    expect(draftDiffersFromSaved(draft, SAVED)).toBe(true);
  });

  it("catches an added section the saved config doesn't have", () => {
    const draft = { ...SAVED, automations: { ownerEmailSummary: true } };
    expect(draftDiffersFromSaved(draft, SAVED)).toBe(true);
  });

  it("refuses to compare junk — a malformed body must not silently pass as 'same'", () => {
    // isFullConfig gates first, so junk means "no draft" and the saved assistant is
    // dialled. It must never be read as a draft that happens to equal the saved config.
    expect(draftDiffersFromSaved({ identity: {} }, SAVED)).toBe(false);
  });
});
