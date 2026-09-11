import { describe, it, expect } from "vitest";
import { callerLabel, isPlaceholderCallerName, realCallerName } from "./callerName.js";

describe("callerLabel", () => {
  it("keeps a real name, trimmed", () => {
    expect(callerLabel("Jane Doe")).toBe("Jane Doe");
    expect(callerLabel("  Isaki  ")).toBe("Isaki");
  });

  it("never returns the stored default 'Unknown'", () => {
    // schema.prisma defaults callerName to "Unknown" — this is the case that was
    // filling the CRM's Leads list with "Unknown".
    expect(callerLabel("Unknown")).toBe("Caller");
    expect(callerLabel("unknown")).toBe("Caller");
    expect(callerLabel("Unknown Caller")).toBe("Caller");
    expect(callerLabel("unknown_caller")).toBe("Caller");
  });

  it("treats the extraction model's empty markers as no name", () => {
    for (const raw of ["", "   ", "n/a", "N/A", "none", "null", "not provided", "-", "Anonymous"]) {
      expect(callerLabel(raw)).toBe("Caller");
    }
    expect(callerLabel(null)).toBe("Caller");
    expect(callerLabel(undefined)).toBe("Caller");
  });

  it("does not mistake a real name that merely contains a placeholder word", () => {
    expect(callerLabel("Unknownson")).toBe("Unknownson");
    expect(callerLabel("Nathan Unknown-Smith")).toBe("Nathan Unknown-Smith");
  });
});

describe("realCallerName", () => {
  it("returns undefined for placeholders so write paths store nothing", () => {
    expect(realCallerName("Unknown")).toBeUndefined();
    expect(realCallerName("")).toBeUndefined();
    expect(realCallerName(null)).toBeUndefined();
  });

  it("returns the trimmed name when it's real", () => {
    expect(realCallerName(" Jane Doe ")).toBe("Jane Doe");
  });
});

describe("isPlaceholderCallerName", () => {
  it("is case- and whitespace-insensitive", () => {
    expect(isPlaceholderCallerName("  UNKNOWN  ")).toBe(true);
    expect(isPlaceholderCallerName("Not   Given")).toBe(true);
    expect(isPlaceholderCallerName("Jane")).toBe(false);
  });
});
