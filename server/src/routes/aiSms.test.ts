import { describe, it, expect } from "vitest";
import { parseTopics, resolveDestination } from "./aiSms.routes.js";

describe("parseTopics", () => {
  it("reads the topics array", () => {
    expect(parseTopics({ topics: ["website", "email"] })).toEqual(["website", "email"]);
  });

  it("tolerates a lone singular topic string", () => {
    expect(parseTopics({ topic: "website" })).toEqual(["website"]);
  });

  it("merges array and singular, de-duplicating case-insensitively", () => {
    expect(parseTopics({ topics: ["website", "Website"], topic: "email" })).toEqual([
      "website",
      "email",
    ]);
  });

  it("ignores blanks and non-string entries", () => {
    expect(parseTopics({ topics: ["", "  ", 5, "email"] })).toEqual(["email"]);
  });

  it("returns nothing when there are no topics", () => {
    expect(parseTopics({})).toEqual([]);
  });
});

describe("resolveDestination", () => {
  const ANI = "+61412345678";

  it("uses the caller's own number when they gave no other", () => {
    expect(resolveDestination("", ANI)).toBe(ANI);
  });

  it("accepts a valid number the caller dictated, in E.164", () => {
    expect(resolveDestination("+61 2 8000 1234", ANI)).toBe("+61280001234");
  });

  it("parses a locally-spoken number against the caller's own country", () => {
    // "0412 999 888" is only unambiguous once you know it's an AU number — which
    // we take from the ANI they're calling on.
    expect(resolveDestination("0412 999 888", ANI)).toBe("+61412999888");
  });

  it("falls back to the caller's number when the dictated one is nonsense", () => {
    expect(resolveDestination("um, my number", ANI)).toBe(ANI);
  });

  it("falls back to the caller's number for an incomplete fragment", () => {
    expect(resolveDestination("0412", ANI)).toBe(ANI);
  });

  it("returns empty only when there's genuinely no number at all", () => {
    expect(resolveDestination("", "")).toBe("");
  });
});
