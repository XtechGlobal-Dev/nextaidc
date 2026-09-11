import { afterEach, describe, expect, it, vi } from "vitest";
import { normalizeEndpoint, traceFetch } from "./apiTrace.js";

/* ------------------------------------------------------------------ *
 *  Endpoint grouping is the one piece of the tracer whose failure mode is
 *  silent: if ids don't collapse, the Errors and Logs screens degenerate into a
 *  list of unique URLs and "this endpoint failed 4,000 times" becomes 4,000 rows
 *  of one. Worth pinning down.
 * ------------------------------------------------------------------ */

describe("normalizeEndpoint", () => {
  it("strips the scheme and host so the same path groups across base URLs", () => {
    expect(normalizeEndpoint("https://api.vapi.ai/assistant")).toBe("/assistant");
    expect(normalizeEndpoint("https://eu.api.vapi.ai/assistant")).toBe("/assistant");
  });

  it("drops the query string, which routinely carries keys and phone numbers", () => {
    expect(normalizeEndpoint("https://api.deepgram.com/v1/speak?model=aura-2-theia-en")).toBe("/v1/speak");
    expect(normalizeEndpoint("/v1/messages?token=secret&to=%2B61400000000")).toBe("/v1/messages");
  });

  it("collapses the id shapes real vendors use", () => {
    // UUID
    expect(normalizeEndpoint("/call/3f2504e0-4f89-11d3-9a0c-0305e82c3301/recording")).toBe(
      "/call/:id/recording",
    );
    // cuid (this codebase's own ids)
    expect(normalizeEndpoint("/booking/clh3k2j9x0000qwer1234asdf")).toBe("/booking/:id");
    // numeric
    expect(normalizeEndpoint("/v1/accounts/992301/usage")).toBe("/v1/accounts/:id/usage");
    // Twilio-style prefixed id (fictitious value: not a valid Account SID shape)
    expect(normalizeEndpoint("/2010-04-01/Accounts/ZZ0123456789abcdef0123456789abcd/Messages")).toBe(
      "/2010-04-01/Accounts/:id/Messages",
    );
    // long hex (API-key-ish path segments, message ids)
    expect(normalizeEndpoint("/v1/messages/a1b2c3d4e5f60718")).toBe("/v1/messages/:id");
  });

  it("collapses phone numbers, which appear as path segments on telephony vendors", () => {
    expect(normalizeEndpoint("/v21.0/+61400000000/messages")).toBe("/v21.0/:id/messages");
    expect(normalizeEndpoint("/lookup/(555) 010-9999")).toBe("/lookup/:id");
  });

  it("keeps genuine path words, including ones that merely contain digits", () => {
    // A version segment is meaningful — collapsing it would merge v1 and v2
    // traffic into one row and hide a broken migration.
    expect(normalizeEndpoint("https://graph.facebook.com/v21.0/messages")).toBe("/v21.0/messages");
    expect(normalizeEndpoint("/v1/text-to-speech/stream")).toBe("/v1/text-to-speech/stream");
  });

  it("is stable across repeated ids so calls to one endpoint become one group", () => {
    const a = normalizeEndpoint("/call/3f2504e0-4f89-11d3-9a0c-0305e82c3301/recording");
    const b = normalizeEndpoint("/call/9c858901-8a57-4791-81fe-4c455b099bc9/recording");
    expect(a).toBe(b);
  });

  it("handles the empty and bare-root cases without throwing", () => {
    expect(normalizeEndpoint("")).toBe("");
    expect(normalizeEndpoint("https://api.example.com")).toBe("/");
    expect(normalizeEndpoint("/")).toBe("/");
  });

  it("truncates pathologically long paths so one bad URL can't bloat the table", () => {
    const long = `/v1/${"segment/".repeat(80)}end`;
    const out = normalizeEndpoint(long);
    expect(out.length).toBeLessThanOrEqual(200);
    expect(out.endsWith("...")).toBe(true);
  });
});

/* ------------------------------------------------------------------ *
 *  Rule 1 of this tracer: telemetry never fails the request it measures.
 *
 *  `traceFetch` wraps live vendor calls, so anything it touches on the response
 *  has to be optional. Real `fetch` always returns a spec-complete Response, but
 *  SDK fetch-alikes, polyfills and test doubles routinely don't — and a thrown
 *  tracer turns a working API call into a failed one. This caught a live bug:
 *  reading rate-limit headers off a response with no `headers` threw straight
 *  through the caller.
 * ------------------------------------------------------------------ */

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("traceFetch resilience", () => {
  it("returns the response even when it carries no headers", async () => {
    // A minimal double: no `headers`, no `clone`, no `text`.
    const bare = { ok: true, status: 200, json: async () => ({ hello: "world" }) };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(bare));

    // OpenAI is a provider WITH rateLimitHeaders configured, so this exercises
    // the header-reading path rather than skipping it.
    const res = await traceFetch("openai", "https://api.openai.com/v1/chat/completions", { method: "POST" });

    expect(res).toBe(bare);
    await expect((res as unknown as typeof bare).json()).resolves.toEqual({ hello: "world" });
  });

  it("survives a response with no headers AND a units extractor", async () => {
    const bare = { ok: true, status: 200, json: async () => ({ usage: { total_tokens: 1500 } }) };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(bare));

    const res = await traceFetch(
      "openai",
      "https://api.openai.com/v1/chat/completions",
      { method: "POST" },
      { unitsFromResponse: () => 1.5 },
    );

    expect(res).toBe(bare);
  });

  it("re-throws a transport failure unchanged, so callers still see the real error", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ECONNREFUSED")));

    await expect(traceFetch("openai", "https://api.openai.com/v1/chat/completions")).rejects.toThrow(
      "ECONNREFUSED",
    );
  });

  it("does not swallow a non-ok response — the caller decides what a 500 means", async () => {
    const failed = {
      ok: false,
      status: 500,
      headers: { get: () => null },
      clone: () => ({ text: async () => "upstream exploded" }),
    };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(failed));

    const res = await traceFetch("openai", "https://api.openai.com/v1/chat/completions");
    expect(res).toBe(failed);
    expect((res as unknown as typeof failed).status).toBe(500);
  });
});
