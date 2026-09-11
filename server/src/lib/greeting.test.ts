import { describe, it, expect } from "vitest";
import { autoGreeting, resolveGreeting } from "./agentConfig.js";

describe("resolveGreeting", () => {
  it("re-derives a generated greeting that still carries the OLD business name", () => {
    // The reported regression: business renamed Samsung India → Coach DA, but the
    // greeting (and so the live agent) kept announcing Samsung India.
    expect(
      resolveGreeting("Thanks for calling Samsung India. How can I help you today?", "Coach DA"),
    ).toBe("Thanks for calling Coach DA. How can I help you today?");
  });

  it("heals the legacy 'How can I help you?' wording too", () => {
    expect(resolveGreeting("Thanks for calling Samsung India. How can I help you?", "Coach DA")).toBe(
      "Thanks for calling Coach DA. How can I help you today?",
    );
  });

  it("heals the business-less default", () => {
    expect(resolveGreeting("Thanks for calling. How can I help you today?", "Coach DA")).toBe(
      "Thanks for calling Coach DA. How can I help you today?",
    );
  });

  it("leaves a greeting the owner wrote untouched", () => {
    const custom = "G'day! You've reached Samsung India — what can I do for you?";
    expect(resolveGreeting(custom, "Coach DA")).toBe(custom);
  });

  it("falls back to the generated greeting when empty", () => {
    expect(resolveGreeting("", "Coach DA")).toBe(autoGreeting("Coach DA"));
    expect(resolveGreeting(undefined, "")).toBe("Thanks for calling. How can I help you today?");
  });

  it("is a no-op once the greeting already matches the business", () => {
    const current = autoGreeting("Coach DA");
    expect(resolveGreeting(current, "Coach DA")).toBe(current);
  });
});
