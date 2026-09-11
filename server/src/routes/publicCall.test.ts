import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";
import express from "express";
import type { Server } from "node:http";

/* ------------------------------------------------------------------ *
 *  Public conversation page (/c/:publicId) — HTTP-level coverage.
 *  Boots the real router against a stubbed Prisma so we observe the
 *  actual rendered HTML, status codes and expiry handling end-to-end.
 * ------------------------------------------------------------------ */

const h = vi.hoisted(() => ({ findFirst: vi.fn(), shareFind: vi.fn(), update: vi.fn() }));

// Mocking a module replaces ALL of its exports, so every export something in
// this route's import graph reads has to be present — a partial mock made the
// whole suite fail to load (and silently run zero tests).
vi.mock("../env.js", () => ({
  // Brand hosts resolve against these; the real module exports them, so a
  // mock that omits them fails to link for anything importing brandUrls.
  platformDomain: "hello22.ai",
  platformDomains: ["hello22.ai"],
  allowUnverifiedBrandDomains: false,
  canonicalApiBaseUrl: "https://api.test",
  publicApiBaseUrl: "https://api.test",
  appBaseUrl: "https://app.test",
  shareLinkBaseUrl: "https://api.test",
  corsOrigins: ["https://app.test"],
  env: {
    // lib/crypto.ts derives its AES key from this at import time.
    JWT_SECRET: "test-secret-for-public-call-suite",
    APP_URL: "https://app.test",
    PUBLIC_API_URL: "https://api.test",
    VAPI_SERVER_URL: "https://api.test",
    SHARE_LINK_BASE_URL: "",
    CORS_ORIGIN: "https://app.test",
  },
}));
// The share route resolves the slug through the control plane's share index
// (which brand, which call), then reads the call from that brand's own
// database — stood in for here — with `findFirst` on its partitioned key.
vi.mock("../prisma.js", () => ({
  prisma: {
    callShare: { findUnique: h.shareFind },
    conversion: { findUnique: vi.fn(async () => null) },
  },
}));
vi.mock("../services/tenantDb.js", async () =>
  (await import("../test/tenantDbFake.js")).tenantDbFake({ callLog: { findFirst: h.findFirst, update: h.update } }),
);
// Answers with the AMBIENT brand's name, the way the real emailGlobals() does —
// so the page can be checked for painting the call owner's brand rather than
// the platform's, even though it is served from the platform's API host.
vi.mock("../services/emailTemplates.js", async () => {
  const { currentBrandId } = await import("../lib/brandContext.js");
  return {
    emailGlobals: () => ({
      app_name: currentBrandId() === "b_acme" ? "Acme Voice" : "Hello22",
      support_email: "support@hello22.ai",
    }),
  };
});

const { default: router } = await import("./publicCall.routes.js");

let server: Server;
let base: string;

beforeEach(() => {
  vi.clearAllMocks();
  // Every slug the tests use belongs to Acme's database unless a test says otherwise.
  h.shareFind.mockImplementation(async ({ where }: { where: { publicId: string } }) => ({
    publicId: where.publicId,
    brandId: "b_acme",
    callId: "call_1",
    callCreatedAt: new Date("2026-07-14T09:00:00Z"),
  }));
  h.update.mockResolvedValue({});
});

// One shared app/port for the suite.
const app = express();
app.use("/c", router);
await new Promise<void>((resolve) => {
  server = app.listen(0, () => {
    const addr = server.address();
    base = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
    resolve();
  });
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

const sampleCall = {
  id: "call_1",
  callerName: "Jane Doe",
  callerNumber: "+61400111222",
  purpose: "Booking a haircut",
  summary: "Caller wants a Saturday appointment.",
  durationSec: 95,
  recordingUrl: "https://storage.vapi.ai/rec.wav",
  transcript: [
    { role: "assistant", text: "Hi, how can I help?" },
    { role: "user", text: "I'd like to book a haircut." },
  ],
  createdAt: new Date("2026-07-14T09:00:00Z"),
  // Relative, NOT a hardcoded date. This was "2026-08-14", which was safely in
  // the future when it was written and quietly became the past — from then on
  // the route correctly returned 410 and both render tests failed for a reason
  // that had nothing to do with the code. A share link that is always ~30 days
  // from now can't rot the same way.
  shareExpiresAt: new Date(Date.now() + 30 * 86_400_000),
};

describe("GET /c/:publicId", () => {
  it("renders the conversation with caller, purpose, recording and transcript", async () => {
    h.findFirst.mockResolvedValue(sampleCall);
    const res = await fetch(`${base}/c/Xa7bK2p9`);
    const html = await res.text();

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(html).toContain("Jane Doe");
    expect(html).toContain("Booking a haircut");
    expect(html).toContain("Caller wants a Saturday appointment.");
    // Recording is proxied through our own domain, never storage.vapi.ai — and
    // via a SIGNED token, never the raw call id (which isn't a secret).
    expect(html).toMatch(/https:\/\/api\.test\/api\/calls\/recording-file\/eyJ[\w.-]+/);
    expect(html).not.toContain("/recording-file/call_1");
    expect(html).not.toContain("storage.vapi.ai");
    // Transcript turns are rendered and labelled.
    expect(html).toContain("I&#39;d like to book a haircut.");
    expect(html).toContain("Agent");
    // Never indexed.
    expect(html).toContain("noindex");
  });

  it("returns 410 with an expiry notice for a link past its validity", async () => {
    h.findFirst.mockResolvedValue({ ...sampleCall, shareExpiresAt: new Date("2000-01-01T00:00:00Z") });
    const res = await fetch(`${base}/c/expired1`);
    const html = await res.text();
    expect(res.status).toBe(410);
    expect(html).toContain("Link expired");
    expect(html).not.toContain("Jane Doe");
  });

  it("returns 404 for an unknown slug", async () => {
    h.findFirst.mockResolvedValue(null);
    const res = await fetch(`${base}/c/nope`);
    expect(res.status).toBe(404);
    expect(await res.text()).toContain("Conversation not found");
  });

  it("escapes HTML in stored fields (no injection)", async () => {
    h.findFirst.mockResolvedValue({
      ...sampleCall,
      callerName: "<script>alert(1)</script>",
      recordingUrl: null,
      transcript: [],
    });
    const res = await fetch(`${base}/c/xss`);
    const html = await res.text();
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("renders a never-expiring link (shareExpiresAt null)", async () => {
    h.findFirst.mockResolvedValue({ ...sampleCall, shareExpiresAt: null });
    const res = await fetch(`${base}/c/forever`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("Jane Doe");
  });
});

describe("GET /c/:publicId — whose name is on the page", () => {
  // The page is served from the platform's API host for every brand, so the
  // request can't say whose it is. The call can.
  it("paints the brand that owns the call, not the platform", async () => {
    h.findFirst.mockResolvedValue({ ...sampleCall, brandId: "b_acme" });
    const res = await fetch(`${base}/c/Xa7bK2p9`);
    const html = await res.text();
    expect(res.status).toBe(200);
    expect(html).toContain("Acme Voice");
    expect(html).not.toContain("Hello22");
  });

  it("keeps the brand on the expired notice too", async () => {
    h.findFirst.mockResolvedValue({
      ...sampleCall,
      brandId: "b_acme",
      shareExpiresAt: new Date(Date.now() - 1000),
    });
    const res = await fetch(`${base}/c/Xa7bK2p9`);
    expect(res.status).toBe(410);
    expect(await res.text()).toContain("Acme Voice");
  });

  // A share row always names its brand, so there is no "call with no brand"
  // any more — but a slug nobody minted must not open any brand's database.
  it("404s a slug with no share row, without opening any brand's database", async () => {
    h.shareFind.mockResolvedValue(null);
    const res = await fetch(`${base}/c/never-minted`);
    expect(res.status).toBe(404);
    expect(h.findFirst).not.toHaveBeenCalled();
  });
});
