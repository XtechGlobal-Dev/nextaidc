import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  SUPPORTED_AGENT_LANGUAGES,
  ELEVENLABS_ONLY_LANGUAGES,
  transcriberFor,
} from "./agentConfig.js";

/* Adding a language touches two files that must agree exactly — the server list
 * sanitizes every save against its copy, so a client-only entry is silently
 * dropped on the next save and the customer's selection just disappears. These
 * pin the mirror, and the transcriber route Nepali actually takes. */

const clientLanguages = readFileSync(
  resolve(import.meta.dirname, "../../../src/data/languages.ts"),
  "utf8",
);

/** The entries of an exported `readonly string[]`-style array literal. */
function arrayEntries(src: string, name: string): string[] {
  const start = src.indexOf(`export const ${name}`);
  expect(start, `${name} not found`).toBeGreaterThan(-1);
  // Anchor on the assignment, not the first "[" — a `readonly string[]` type
  // annotation sits between the name and the array literal.
  const open = src.indexOf("[", src.indexOf("=", start));
  const close = src.indexOf("]", open);
  return [...src.slice(open, close).matchAll(/"([^"]+)"/g)]
    .map((m) => m[1])
    // Commented-out entries (Punjabi) are still quoted — drop them.
    .filter((entry) => {
      const line = src.slice(open, close).split("\n").find((l) => l.includes(`"${entry}"`)) ?? "";
      return !line.trim().startsWith("//");
    });
}

describe("Nepali language support", () => {
  it("is offered as a switch-to language", () => {
    expect(SUPPORTED_AGENT_LANGUAGES).toContain("Nepali");
  });

  it("is ElevenLabs-only — Deepgram voices can't speak it", () => {
    expect(ELEVENLABS_ONLY_LANGUAGES).toContain("Nepali");
  });

  it("routes to the Google transcriber, since Deepgram's multi set has no Nepali", () => {
    // The whole point of ELEVENLABS_ONLY: Deepgram would return confident
    // garbage in the wrong script rather than admitting it can't hear it.
    expect(transcriberFor(["Nepali"])).toEqual({
      provider: "google",
      model: "gemini-2.5-flash",
      language: "Multilingual",
    });
  });

  it("still uses Deepgram when only Deepgram-covered languages are on", () => {
    expect(transcriberFor(["Hindi", "Spanish"])).toEqual({
      provider: "deepgram",
      model: "nova-3",
      language: "multi",
    });
  });

  it("drops to Google as soon as Nepali joins a Deepgram-covered set", () => {
    expect(transcriberFor(["Hindi", "Nepali"]).provider).toBe("google");
  });
});

describe("client and server language lists mirror each other", () => {
  it("offers exactly the same switch-to languages", () => {
    expect(arrayEntries(clientLanguages, "AGENT_LANGUAGES")).toEqual([
      ...SUPPORTED_AGENT_LANGUAGES,
    ]);
  });

  it("agrees on which languages are ElevenLabs-only", () => {
    expect(arrayEntries(clientLanguages, "ELEVENLABS_ONLY_LANGUAGES")).toEqual([
      ...ELEVENLABS_ONLY_LANGUAGES,
    ]);
  });
});
