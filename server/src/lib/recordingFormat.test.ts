import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/* ------------------------------------------------------------------ *
 *  Call recordings are MP3.
 *
 *  Vapi defaults to `wav;l16` — roughly 10 MB per minute, and a file plenty of
 *  phones and mail clients won't preview. Owners forward these to customers and
 *  insurers, so the format has to be the ordinary one. It is set on the
 *  assistant, which means it can silently revert to WAV if `artifactPlan` is
 *  ever rewritten without it — nothing would fail, recordings would just get
 *  ten times heavier again.
 *
 *  Both payload builders are pinned: the server's (live agents) and the
 *  browser's (test calls), so a test call keeps producing the same kind of file
 *  a real call does.
 * ------------------------------------------------------------------------- */

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

/* The download names the file from the upstream content-type rather than a
 * hardcoded extension, which is what lets old WAV recordings and new MP3s live
 * side by side. Pinned here because that link is easy to miss. */
describe("the download follows the format instead of assuming one", () => {
  it("maps an MP3 content-type to a .mp3 filename", () => {
    const callsSrc = read("../routes/calls.routes.ts");
    expect(callsSrc).toMatch(/if \(t\.includes\("mpeg"\) \|\| t\.includes\("mp3"\)\) return "mp3";/);
  });
});
