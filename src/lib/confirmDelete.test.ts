import { describe, it, expect } from "vitest";
import { confirmPhrase, isConfirmed } from "./confirmDelete";

describe("confirmPhrase", () => {
  it("builds `delete <type> <name>`", () => {
    expect(confirmPhrase("web service", "AgentLabs-AI-Dev-1")).toBe(
      "delete web service AgentLabs-AI-Dev-1",
    );
    expect(confirmPhrase("role", "Ops")).toBe("delete role Ops");
  });
});

describe("isConfirmed", () => {
  it("is false until the input exactly matches the phrase", () => {
    // Partial input as the user types — the button gate stays closed throughout.
    const partials = ["", "d", "delete", "delete role", "delete role Op"];
    for (const p of partials) {
      expect(isConfirmed(p, "role", "Ops")).toBe(false);
    }
    expect(isConfirmed("delete role Ops", "role", "Ops")).toBe(true);
  });

  it("keeps the gate closed for incorrect input", () => {
    // Wrong case (case-sensitive), wrong name, and stray whitespace all fail.
    expect(isConfirmed("Delete role Ops", "role", "Ops")).toBe(false);
    expect(isConfirmed("delete role ops", "role", "Ops")).toBe(false);
    expect(isConfirmed("delete role Finance", "role", "Ops")).toBe(false);
    expect(isConfirmed("delete role Ops ", "role", "Ops")).toBe(false);
    expect(isConfirmed(" delete role Ops", "role", "Ops")).toBe(false);
    expect(isConfirmed("delete  role Ops", "role", "Ops")).toBe(false);
  });

  it("matches names/types with spaces and mixed case exactly", () => {
    expect(isConfirmed("delete web service AgentLabs-AI-Dev-1", "web service", "AgentLabs-AI-Dev-1")).toBe(true);
    expect(isConfirmed("delete web service agentlabs-ai-dev-1", "web service", "AgentLabs-AI-Dev-1")).toBe(false);
  });
});
