import { describe, it, expect } from "vitest";
import { buildTransferTool, transferPromptSection, type TransferPlan } from "./vapi.js";

const plan = (over: Partial<TransferPlan> = {}): TransferPlan => ({
  enabled: true,
  fallbackMessage: "Nobody's here, we'll call you back.",
  transferNumber: "+1 (555) 010-2020",
  ringTimeoutSec: 30,
  departments: [],
  ...over,
});

describe("buildTransferTool", () => {
  it("returns null when transfer is disabled", () => {
    expect(buildTransferTool(plan({ enabled: false }))).toBeNull();
    expect(buildTransferTool(null)).toBeNull();
  });

  it("returns null when no departments are configured (no legacy single-number fallback)", () => {
    // Department routing is the only transfer path — a stale transferNumber must
    // never keep connecting callers once every department has been removed.
    expect(buildTransferTool(plan({ departments: [] }))).toBeNull();
    expect(buildTransferTool(plan({ departments: [], transferNumber: "+1 (555) 010-2020" }))).toBeNull();
  });

  it("builds a warm-transfer-experimental destination per department with its end message", () => {
    const tool = buildTransferTool(
      plan({
        departments: [
          {
            name: "Sales",
            number: "+1 (555) 010-2020",
            fallbackMessage: "Nobody's here, we'll call you back.",
          },
        ],
      }),
    );
    expect(tool).not.toBeNull();
    expect(tool!.type).toBe("transferCall");
    expect(tool!.destinations).toHaveLength(1);
    const dest = tool!.destinations[0];
    expect(dest.number).toBe("+15550102020");
    expect(dest.type).toBe("number");
    // Warm transfer via a real operator-leg assistant (answer gating), not blind.
    expect(dest.transferPlan?.mode).toBe("warm-transfer-experimental");
    expect(dest.transferPlan?.transferAssistant.firstMessageMode).toBe("assistant-speaks-first");
    expect(dest.transferPlan?.transferAssistant.model.provider).toBeTruthy();
    // No invalid fields that make Vapi fall back to blind.
    expect(dest).not.toHaveProperty("message");
    expect(dest.transferPlan).not.toHaveProperty("voicemailDetectionType");
    expect(dest.transferPlan).not.toHaveProperty("fallbackPlan");
    // The "couldn't connect" line lives at the tool root as a request-failed
    // message. It must NOT hang up — control returns to the AI to take a message.
    const failed = tool!.messages?.find((m) => m.type === "request-failed");
    expect(failed?.content).toBe("Nobody's here, we'll call you back.");
    expect(failed?.endCallAfterSpokenEnabled).toBe(false);
  });

  it("builds one warm destination per enabled department when configured", () => {
    const tool = buildTransferTool(
      plan({
        departments: [
          { name: "Sales", number: "+1 (555) 111-2222", description: "pricing, quotes" },
          { name: "Billing", number: "+1 (555) 333-4444" },
        ],
      }),
    );
    expect(tool!.destinations).toHaveLength(2);
    expect(tool!.destinations[0].number).toBe("+15551112222");
    expect(tool!.destinations[0].description).toContain("Sales");
    expect(tool!.destinations[0].description).toContain("pricing, quotes");
    expect(tool!.destinations[1].number).toBe("+15553334444");
    // Every department destination is a warm-transfer-experimental leg.
    expect(tool!.destinations[0].transferPlan?.mode).toBe("warm-transfer-experimental");
    // The operator-leg assistant announces the specific department.
    expect(tool!.destinations[0].transferPlan?.transferAssistant.firstMessage).toContain("Sales");
  });

  it("skips departments with a missing/invalid number, and returns null when none remain valid", () => {
    const tool = buildTransferTool(
      plan({ departments: [{ name: "Sales", number: "123" }, { name: "NoNumber", number: "" }] }),
    );
    // No valid department → no transfer at all (no legacy single-number fallback).
    expect(tool).toBeNull();
  });
});

describe("transferPromptSection with departments", () => {
  it("tells the AI to ask which department and lists them", () => {
    const section = transferPromptSection(
      plan({
        departments: [
          { name: "Sales", number: "+15551112222", description: "pricing" },
          { name: "Support", number: "+15553334444" },
        ],
      }),
    );
    expect(section).toContain("ask which department");
    expect(section).toContain("Sales");
    expect(section).toContain("Support");
  });
});

describe("transferPromptSection", () => {
  it("gives human-intent guidance and message-taking on a failed transfer", () => {
    const section = transferPromptSection(plan());
    expect(section).toContain("## HUMAN TRANSFER");
    expect(section).toContain("transferCall");
    // On a failed transfer the AI takes a message tagged with the department.
    expect(section).toContain("IF THE TRANSFER CAN'T CONNECT");
    expect(section).toContain("take a message");
    expect(section).toContain("WHICH department");
  });
});
