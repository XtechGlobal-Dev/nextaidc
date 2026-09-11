import { describe, it, expect, vi, beforeEach } from "vitest";

/* ------------------------------------------------------------------ *
 *  Persisted prompt-summary cache. The summariser makes a slow OpenAI call; the
 *  DB cache lets an unchanged prompt skip it — even after a cold start (the main
 *  cause of the 15-20s test-call connect). These tests prove a DB hit skips the
 *  LLM entirely, and a miss computes then persists the result.
 * ------------------------------------------------------------------ */

const h = vi.hoisted(() => ({
  openaiConfigured: true,
  findUnique: vi.fn(),
  upsert: vi.fn(async (_args: { create: { hash: string; summary: string } }) => ({})),
  fetch: vi.fn(),
}));

vi.mock("./settings.js", () => ({
  integrationsStatus: () => ({ openai: h.openaiConfigured }),
  getEffective: (k: string) => (k === "openai.apiKey" ? "sk-test" : k === "openai.model" ? "gpt-5" : ""),
}));
// The double must mirror the module's real export surface: promptSummarizer also
// imports `openAiTokenUnits` (it reports token usage to the API Center tracer).
// These tests don't care what the call cost, so a zero is fine — but the export
// has to exist, or accessing it throws and the summariser falls back to the
// original prompt, which looks exactly like an LLM failure.
vi.mock("../lib/openai.js", () => ({
  buildChatBody: (b: unknown) => b,
  openAiTokenUnits: () => 0,
}));
vi.mock("../prisma.js", () => ({
  prisma: { promptCache: { findUnique: h.findUnique, upsert: h.upsert } },
}));

vi.stubGlobal("fetch", h.fetch);

const { summarizePromptForVapi } = await import("./promptSummarizer.js");

// Long enough to cross MIN_CHARS_TO_SUMMARIZE (1800). Unique per test so the
// module-level in-memory cache from an earlier test can't mask DB behaviour.
const longPrompt = (tag: string) => `${tag} `.repeat(400); // ~2000+ chars

function openaiReturns(summary: string) {
  h.fetch.mockResolvedValue({
    ok: true,
    json: async () => ({ choices: [{ message: { content: summary } }] }),
  } as unknown as Response);
}

beforeEach(() => {
  vi.clearAllMocks();
  h.openaiConfigured = true;
  h.findUnique.mockResolvedValue(null);
});

describe("summarizePromptForVapi — persisted cache", () => {
  it("returns the DB-cached summary and never calls OpenAI on a hit", async () => {
    const prompt = longPrompt("db-hit");
    h.findUnique.mockResolvedValue({ summary: "CACHED SUMMARY" });

    const out = await summarizePromptForVapi(prompt);

    expect(out).toBe("CACHED SUMMARY");
    expect(h.fetch).not.toHaveBeenCalled(); // the whole point — no LLM latency
    expect(h.upsert).not.toHaveBeenCalled();
  });

  it("computes via OpenAI on a miss and persists the result", async () => {
    const prompt = longPrompt("db-miss"); // ~2400 chars
    const summary = "SHORT ".repeat(250); // ~1500 chars: shorter than original, above the keep-ratio floor
    openaiReturns(summary.trim());

    const out = await summarizePromptForVapi(prompt);

    expect(h.fetch).toHaveBeenCalledTimes(1);
    expect(out).toBe(summary.trim());
    // Persisted so a cold start / another instance reuses it.
    expect(h.upsert).toHaveBeenCalledTimes(1);
    expect(h.upsert.mock.calls[0][0].create.summary).toBe(summary.trim());
  });

  it("still returns a usable prompt (and does not persist) when a DB read fails", async () => {
    const prompt = longPrompt("db-error");
    h.findUnique.mockRejectedValue(new Error("db down"));
    const summary = "SHORT ".repeat(250);
    openaiReturns(summary.trim());

    const out = await summarizePromptForVapi(prompt);
    expect(out).toBe(summary.trim()); // fell through to the LLM, didn't throw
  });

  it("skips the cache entirely when OpenAI isn't configured", async () => {
    h.openaiConfigured = false;
    const prompt = longPrompt("no-openai");

    const out = await summarizePromptForVapi(prompt);
    expect(out).toBe(prompt.trim()); // returns the original, unsummarised
    expect(h.findUnique).not.toHaveBeenCalled();
    expect(h.fetch).not.toHaveBeenCalled();
  });
});
