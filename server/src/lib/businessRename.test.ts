import { describe, it, expect } from "vitest";
import {
  DEFAULT_AGENT_CONFIG,
  renameBusinessInConfig,
  replaceBusinessName,
  type AgentConfig,
} from "./agentConfig.js";

/** A config shaped like one onboarding generates: scenarios/FAQs/facts that name
 *  the business, which is exactly what used to go stale on a rename. */
function configFor(businessName: string): AgentConfig {
  const base = structuredClone(DEFAULT_AGENT_CONFIG) as AgentConfig;
  return {
    ...base,
    identity: { ...base.identity, businessName, greetingMessage: `Hi, ${businessName} here!` },
    knowledge: {
      ...base.knowledge,
      services: [`${businessName} express delivery`],
      faqs: [{ id: "f1", question: `Where is ${businessName} based?`, answer: `${businessName} is in Leeds.` }],
      quickFacts: [{ id: "q1", key: "Owner", value: `${businessName} Ltd` }],
    },
    rules: {
      ...base.rules,
      scenarioHandling: [
        { id: "sc_existing", ifText: `The caller is an existing customer of ${businessName}`, thenText: "Take a message" },
      ],
    },
  };
}

describe("replaceBusinessName", () => {
  it("renames standalone mentions, whatever the casing", () => {
    expect(replaceBusinessName("An existing customer of Reebok called reebok", "reebok", "insta")).toBe(
      "An existing customer of insta called insta",
    );
  });

  it("never renames inside a longer word", () => {
    expect(replaceBusinessName("Post it on Instagram, not insta", "insta", "reebok")).toBe(
      "Post it on Instagram, not reebok",
    );
  });

  it("matches a name sitting against punctuation", () => {
    expect(replaceBusinessName("Call Acme's team (Acme).", "Acme", "Zenith")).toBe(
      "Call Zenith's team (Zenith).",
    );
  });

  it("leaves text that never named the business alone", () => {
    expect(replaceBusinessName("Take a message", "reebok", "insta")).toBe("Take a message");
  });
});

describe("renameBusinessInConfig", () => {
  it("carries the rename through scenarios, knowledge and the greeting", () => {
    const renamed = renameBusinessInConfig(configFor("reebok"), "reebok", "insta");
    expect(renamed.rules.scenarioHandling[0].ifText).toBe("The caller is an existing customer of insta");
    expect(renamed.knowledge.faqs[0].question).toBe("Where is insta based?");
    expect(renamed.knowledge.faqs[0].answer).toBe("insta is in Leeds.");
    expect(renamed.knowledge.services[0]).toBe("insta express delivery");
    expect(renamed.knowledge.quickFacts[0].value).toBe("insta Ltd");
    expect(renamed.identity.greetingMessage).toBe("Hi, insta here!");
  });

  it("returns the SAME config object when nothing mentions the old name", () => {
    const config = configFor("reebok");
    expect(renameBusinessInConfig(config, "someone else", "insta")).toBe(config);
  });

  it("is a no-op for an unchanged name and idempotent when applied twice", () => {
    const config = configFor("reebok");
    expect(renameBusinessInConfig(config, "reebok", "reebok")).toBe(config);
    const once = renameBusinessInConfig(config, "reebok", "insta");
    expect(renameBusinessInConfig(once, "reebok", "insta")).toBe(once);
  });

  it("refuses to sweep on a previous name too short to match safely", () => {
    const config = configFor("a");
    expect(renameBusinessInConfig(config, "a", "insta")).toBe(config);
  });

  it("rewrites a manually edited master prompt but not an auto-compiled one", () => {
    const base = configFor("reebok");
    const auto: AgentConfig = {
      ...base,
      advanced: { ...base.advanced, masterPrompt: "receptionist for reebok", masterPromptDirty: false },
    };
    expect(renameBusinessInConfig(auto, "reebok", "insta").advanced.masterPrompt).toBe("receptionist for reebok");

    const edited: AgentConfig = { ...auto, advanced: { ...auto.advanced, masterPromptDirty: true } };
    expect(renameBusinessInConfig(edited, "reebok", "insta").advanced.masterPrompt).toBe("receptionist for insta");
  });
});
