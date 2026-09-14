import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// Recordings must be MP3. Vapi defaults to wav;l16 (~10 MB/min, unplayable on many phones), and a
// rewritten `artifactPlan` would silently revert to it. Both payload builders (server + browser) are pinned.

const read = (p: string) => readFileSync(resolve(import.meta.dirname, p), "utf8");
const serverSrc = read("../services/vapi.ts");
const browserSrc = read("../../../src/lib/vapi.ts");

describe.each([
  ["live agents (server)", serverSrc],
  ["browser test calls", browserSrc],
])("%s", (_label, src) => {
  it("asks Vapi for MP3 recordings", () => {
    expect(src).toMatch(/artifactPlan: \{ recordingEnabled: true, recordingFormat: "mp3" \}/);
  });

  it("still records at all — the format is worthless if recording is off", () => {
    expect(src).toMatch(/recordingEnabled: true/);
  });
});

// The download extension follows the upstream content-type so old WAVs and new MP3s coexist.
describe("the download follows the format instead of assuming one", () => {
  it("maps an MP3 content-type to a .mp3 filename", () => {
    const callsSrc = read("../routes/calls.routes.ts");
    expect(callsSrc).toMatch(/if \(t\.includes\("mpeg"\) \|\| t\.includes\("mp3"\)\) return "mp3";/);
  });
});
