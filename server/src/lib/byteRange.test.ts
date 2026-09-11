import { describe, it, expect } from "vitest";
import { parseByteRange } from "./byteRange.js";

/* Guards the recording proxy's seek support: a player jumping mid-recording
   sends `Range: bytes=…`, and getting these wrong sends playback back to 0:00. */
describe("parseByteRange", () => {
  const SIZE = 1000;

  it("parses an open-ended range (the usual seek)", () => {
    expect(parseByteRange("bytes=400-", SIZE)).toEqual({ start: 400, end: 999 });
  });

  it("parses a closed range", () => {
    expect(parseByteRange("bytes=0-99", SIZE)).toEqual({ start: 0, end: 99 });
  });

  it("parses a suffix range (last N bytes)", () => {
    expect(parseByteRange("bytes=-200", SIZE)).toEqual({ start: 800, end: 999 });
  });

  it("clamps an end past the last byte", () => {
    expect(parseByteRange("bytes=900-5000", SIZE)).toEqual({ start: 900, end: 999 });
  });

  it("tolerates surrounding whitespace", () => {
    expect(parseByteRange(" bytes=10-20 ", SIZE)).toEqual({ start: 10, end: 20 });
  });

  it("reports a start beyond the resource as unsatisfiable", () => {
    expect(parseByteRange("bytes=1000-", SIZE)).toBe("unsatisfiable");
    expect(parseByteRange("bytes=5000-6000", SIZE)).toBe("unsatisfiable");
  });

  it("reports an inverted or empty range as unsatisfiable", () => {
    expect(parseByteRange("bytes=500-100", SIZE)).toBe("unsatisfiable");
    expect(parseByteRange("bytes=-", SIZE)).toBe("unsatisfiable");
    expect(parseByteRange("bytes=-0", SIZE)).toBe("unsatisfiable");
  });

  it("falls back to the whole body for forms we don't implement", () => {
    expect(parseByteRange("bytes=0-49,100-149", SIZE)).toBeNull(); // multi-range
    expect(parseByteRange("items=0-10", SIZE)).toBeNull(); // other unit
    expect(parseByteRange("bytes=abc-def", SIZE)).toBeNull();
  });

  it("returns null when the size is unknown", () => {
    expect(parseByteRange("bytes=0-99", 0)).toBeNull();
  });
});
