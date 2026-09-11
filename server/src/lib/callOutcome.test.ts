import { describe, it, expect } from "vitest";
import { CallOutcome } from "@prisma/tenant-client";
import { deriveOutcome } from "./callOutcome.js";

describe("deriveOutcome", () => {
  it("maps voicemail reasons", () => {
    expect(deriveOutcome("voicemail", 12)).toBe(CallOutcome.voicemail);
    expect(deriveOutcome("Voicemail", 0)).toBe(CallOutcome.voicemail);
  });

  it("maps missed reasons (no-answer / busy / missed)", () => {
    expect(deriveOutcome("customer-did-not-answer", 0)).toBe(CallOutcome.missed);
    expect(deriveOutcome("customer-busy", 0)).toBe(CallOutcome.missed);
    expect(deriveOutcome("twilio-failed-to-connect-call-no-answer", 0)).toBe(CallOutcome.missed);
    expect(deriveOutcome("missed", undefined)).toBe(CallOutcome.missed);
  });

  it("maps error/failure reasons to failed", () => {
    expect(deriveOutcome("pipeline-error-openai-llm-failed", 3)).toBe(CallOutcome.failed);
    expect(deriveOutcome("assistant-error", 3)).toBe(CallOutcome.failed);
    expect(deriveOutcome("call.start.error-vapifault", 0)).toBe(CallOutcome.failed);
    expect(deriveOutcome("phone-call-provider-rejected", 0)).toBe(CallOutcome.failed);
  });

  it("maps normal end reasons to completed", () => {
    expect(deriveOutcome("customer-ended-call", 42)).toBe(CallOutcome.completed);
    expect(deriveOutcome("assistant-ended-call", 42)).toBe(CallOutcome.completed);
    expect(deriveOutcome("silence-timed-out", 42)).toBe(CallOutcome.completed);
  });

  it("treats unknown reason with zero/no duration as missed (never connected)", () => {
    expect(deriveOutcome(undefined, undefined)).toBe(CallOutcome.missed);
    expect(deriveOutcome(null, 0)).toBe(CallOutcome.missed);
    expect(deriveOutcome("", 0)).toBe(CallOutcome.missed);
  });

  it("treats unknown reason WITH duration as completed", () => {
    expect(deriveOutcome(undefined, 30)).toBe(CallOutcome.completed);
    expect(deriveOutcome("some-new-vapi-reason", 30)).toBe(CallOutcome.completed);
  });
});
