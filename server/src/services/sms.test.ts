import { describe, it, expect } from "vitest";
import { buildCallSummarySms } from "./sms.js";

describe("buildCallSummarySms", () => {
  it("builds the Caller / Purpose / More info template", () => {
    const body = buildCallSummarySms({
      callerName: "Jane Doe",
      callerNumber: "+61400111222",
      purpose: "Booking a haircut",
      conversationUrl: "https://agent.hello22.ai/c/Xa7bK2p9",
    });
    expect(body).toBe(
      "Caller: Jane Doe (+61400111222)\nPurpose: Booking a haircut\nMore info: https://agent.hello22.ai/c/Xa7bK2p9",
    );
    expect(body.length).toBeLessThanOrEqual(160);
  });

  it("never exceeds 160 characters, trimming the purpose to a whole word", () => {
    const long =
      "The caller asked about scheduling a full home electrical rewire, requested an " +
      "on-site quote next Tuesday morning, and wanted to confirm whether the team is " +
      "licensed and insured for older properties in the area.";
    const body = buildCallSummarySms({
      callerName: "Robert",
      callerNumber: "+61400111222",
      summary: long, // no explicit purpose → falls back to the summary
      conversationUrl: "https://agent.hello22.ai/c/Xa7bK2p9",
    });
    expect(body.length).toBeLessThanOrEqual(160);
    expect(body.endsWith("...")).toBe(false);
    // The purpose line ends on a whole word (no fragment / dangling punctuation).
    const purposeLine = body.split("\n").find((l) => l.startsWith("Purpose:"))!;
    expect(purposeLine).toMatch(/\w$/);
  });

  it("never truncates the link, even with a long name and purpose", () => {
    const url = "https://agent.hello22.ai/c/Xa7bK2p9";
    const body = buildCallSummarySms({
      callerName: "Alexander Bartholomew",
      purpose:
        "Detailed enquiry about scheduling a recurring weekly cleaning service across three properties",
      conversationUrl: url,
    });
    expect(body.length).toBeLessThanOrEqual(160);
    expect(body).toContain(`More info: ${url}`);
    // The full URL survives intact.
    expect(body.endsWith(url)).toBe(true);
  });

  it("does not cut a word in the middle of the purpose", () => {
    const purpose = "Requesting information regarding warranty coverage extension options available";
    const body = buildCallSummarySms({
      callerName: "Priya",
      purpose,
      conversationUrl: "https://agent.hello22.ai/c/Xa7bK2p9",
    });
    expect(body.length).toBeLessThanOrEqual(160);
    const purposeLine = body.split("\n").find((l) => l.startsWith("Purpose:"))!;
    const emitted = purposeLine.replace("Purpose: ", "").split(/\s+/).filter(Boolean);
    const originalWords = new Set(purpose.split(/\s+/));
    for (const w of emitted) expect(originalWords.has(w)).toBe(true);
  });

  it("omits the link line when no conversation URL is given", () => {
    const body = buildCallSummarySms({
      callerName: "Sam",
      purpose: "Quote for a fence",
    });
    expect(body).toBe("Caller: Sam\nPurpose: Quote for a fence");
    expect(body).not.toContain("More info:");
  });

  it("omits the purpose line when there's nothing to say", () => {
    const body = buildCallSummarySms({
      callerName: "Sam",
      conversationUrl: "https://agent.hello22.ai/c/Xa7bK2p9",
    });
    expect(body).toBe("Caller: Sam\nMore info: https://agent.hello22.ai/c/Xa7bK2p9");
    expect(body).not.toContain("Purpose:");
  });

  it("falls back to a placeholder when the caller name is missing", () => {
    const body = buildCallSummarySms({ callerName: "", purpose: "General enquiry" });
    expect(body.startsWith("Caller: Unknown caller")).toBe(true);
  });
});
