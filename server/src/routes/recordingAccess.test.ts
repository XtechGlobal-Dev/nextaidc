import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";
import express from "express";
import type { Server } from "node:http";

// Recording access. The proxy used to key off the raw call-log id (visible in logs
// and history, streamable forever); now only a signed, expiring token works.

const h = vi.hoisted(() => ({
  // Both recording routes read with `findFirst`: `call_logs` is partitioned,
  // so `id` alone is no longer a unique key Prisma will accept.
  callLogFindFirst: vi.fn(),
  conversionFindUnique: vi.fn(),
  fetchVapiRecording: vi.fn(),
  callDb: vi.fn(),
}));

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
    JWT_SECRET: "test-secret-for-recording-suite",
    APP_URL: "https://app.test",
    PUBLIC_API_URL: "https://api.test",
    VAPI_SERVER_URL: "https://api.test",
    JWT_EXPIRES_IN: "7d",
  },
}));

vi.mock("../prisma.js", () => ({
  prisma: {
    conversion: { findUnique: h.conversionFindUnique, create: vi.fn() },
    user: { findUnique: vi.fn() },
  },
}));
// Calls are in the brand's own database. The public recording proxy asks for
// it by the brand named in the token; the owner endpoint by the session's.
vi.mock("../services/tenantDb.js", async () =>
  (await import("../test/tenantDbFake.js")).tenantDbFake({ appointment: { count: async () => 0 } }, "b_acme", { callDb: h.callDb }),
);

// Auth: the owner endpoint runs as user_1 of brand b_acme; the public endpoint
// ignores this.
vi.mock("../services/customerDirectory.js", () => ({ brandIdForOwner: async () => "b_acme" }));
vi.mock("../middleware/auth.js", () => ({
  requireAuth: (req: any, _res: any, next: any) => {
    req.user = { sub: "user_1", brandId: "b_acme" };
    next();
  },
  // These routes now sit behind requireCustomerAccount too; the role rules are
  // covered in brandAccess.test.ts, so wave it through here.
  requireCustomerAccount: (_r: any, _s: any, n: any) => n(),
}));
vi.mock("../middleware/trial.js", () => ({ validateTrial: (_r: any, _s: any, n: any) => n() }));

vi.mock("../services/settings.js", () => ({
  integrationsStatus: () => ({ vapi: true, email: false, openai: false, perfex: false }),
  getEffective: () => "",
}));
vi.mock("../services/vapi.js", () => ({
  getCallRecordingUrl: vi.fn(async () => null),
  fetchVapiRecording: h.fetchVapiRecording,
}));
// The rest of the import graph — stubbed so the router loads.
vi.mock("../services/trial.js", () => ({
  recordUsage: vi.fn(),
  settleAfterCall: vi.fn(),
  getPlanFeatures: vi.fn(async () => ({ sms: false, whatsapp: false })),
  getCallDurationCap: vi.fn(async () => 0),
}));
vi.mock("../services/billing.js", () => ({ enforceTrialMinutes: vi.fn() }));
vi.mock("../services/provisioning.js", () => ({ settleAfterCall: vi.fn() }));
vi.mock("../services/webhook.js", () => ({ deliverCallToCrm: vi.fn() }));
vi.mock("../services/notifications.js", () => ({ notify: vi.fn() }));
vi.mock("../services/booking.js", () => ({ maybeCreateCalendarBooking: vi.fn(async () => ({ ok: false })) }));
vi.mock("../services/callWrapUp.js", () => ({ scheduleWrapUp: vi.fn(), cancelWrapUp: vi.fn() }));
vi.mock("../services/email.js", () => ({ callSummaryEmail: vi.fn() }));
vi.mock("../services/sms.js", () => ({ isTwilioConfigured: () => false, callSummarySms: vi.fn() }));
vi.mock("../services/whatsapp.js", () => ({ isWhatsAppConfigured: () => false, callSummaryWhatsApp: vi.fn() }));
vi.mock("../services/summary.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../services/summary.js")>()),
  summarizeCallTranscript: vi.fn(async () => ""),
  classifyCallIntent: vi.fn(async () => ({ category: "", contactCaptured: false })),
  translateText: vi.fn(async () => ""),
  translateTranscript: vi.fn(async () => null),
}));

const { default: router } = await import("./calls.routes.js");
const { signRecording } = await import("../lib/jwt.js");

let server: Server;
let base: string;
const app = express();
app.use(express.json());
app.use("/api/calls", router);
await new Promise<void>((resolve) => {
  server = app.listen(0, () => {
    const addr = server.address();
    base = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
    resolve();
  });
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

beforeEach(() => {
  vi.clearAllMocks();
  h.conversionFindUnique.mockResolvedValue({ id: "conv_1" });
  h.callDb.mockResolvedValue({
    callLog: { findFirst: h.callLogFindFirst, findUnique: vi.fn(), create: vi.fn(), update: vi.fn() },
  });
});

describe("GET /recording-file/:token — token required", () => {
  it("rejects the raw call-log id (the old, non-secret key) with 404", async () => {
    const res = await fetch(`${base}/api/calls/recording-file/call_1`);
    expect(res.status).toBe(404);
    // Rejected at the token gate — we never even look the call up.
    expect(h.callLogFindFirst).not.toHaveBeenCalled();
  });

  it("rejects a random/garbage token with 404 and no lookup", async () => {
    const res = await fetch(`${base}/api/calls/recording-file/not-a-real-token`);
    expect(res.status).toBe(404);
    expect(h.callLogFindFirst).not.toHaveBeenCalled();
  });

  it("accepts a validly-signed token and looks up the encoded call id", async () => {
    // Call exists but has nothing streamable, so it still ends 404 — the point
    // is that the token passed the gate and the DECODED id drove the lookup.
    h.callLogFindFirst.mockResolvedValue({ recordingUrl: null, analysis: {} });
    const token = signRecording("call_1", "b_acme", "12h");

    const res = await fetch(`${base}/api/calls/recording-file/${token}`);
    // The token names the brand, and that brand's database is the one asked.
    expect(h.callDb).toHaveBeenCalledWith("b_acme");
    expect(h.callLogFindFirst).toHaveBeenCalledWith({
      where: { id: "call_1" },
      select: {
        id: true,
        createdAt: true,
        recordingUrl: true,
        // vapiCallId keeps playback working after the analysis blob is archived to S3;
        // `analysis` is only the fallback for rows the backfill hasn't reached.
        vapiCallId: true,
        analysis: true,
        // callerName is read so a download gets a readable filename.
        callerName: true,
      },
    });
    // No audio to serve in this stub → not available (but token was accepted).
    expect(res.status).toBe(404);
  });
});

describe("GET /:id/recording-url — owner mints a playback link", () => {
  it("returns a signed proxy URL for the owner's own call", async () => {
    h.callLogFindFirst.mockResolvedValue({
      id: "call_1",
      recordingUrl: null,
      analysis: { vapiCallId: "vapi_9" },
    });

    const res = await fetch(`${base}/api/calls/call_1/recording-url`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { url: string | null };
    expect(body.url).toMatch(/^https:\/\/api\.test\/api\/calls\/recording-file\/eyJ[\w.-]+$/);
    expect(body.url).not.toContain("/recording-file/call_1");
  });

  it("404s for a call that isn't the caller's", async () => {
    h.callLogFindFirst.mockResolvedValue(null);
    const res = await fetch(`${base}/api/calls/someone-elses/recording-url`);
    expect(res.status).toBe(404);
  });

  it("returns url:null when there's nothing to stream", async () => {
    h.callLogFindFirst.mockResolvedValue({ id: "call_1", recordingUrl: null, analysis: {} });
    const res = await fetch(`${base}/api/calls/call_1/recording-url`);
    expect(res.status).toBe(200);
    expect((await res.json())).toEqual({ url: null });
  });
});

// A shared link leaves the dashboard, so it can't use the dashboard's short token
// (re-minted on every open — a pasted copy would die within hours).
describe("GET /:id/recording-url?share=1 — a link meant to be sent to someone", () => {
  /** Seconds of life left on the signed token inside a proxy URL. */
  const ttlSecondsOf = (url: string) => {
    const token = url.split("/recording-file/")[1]!;
    const payload = JSON.parse(
      Buffer.from(token.split(".")[1]!, "base64url").toString("utf8"),
    ) as { exp: number; iat: number; kind: string; sub: string };
    expect(payload.kind).toBe("recording");
    expect(payload.sub).toBe("call_1");
    return payload.exp - payload.iat;
  };

  beforeEach(() => {
    h.callLogFindFirst.mockResolvedValue({
      id: "call_1",
      recordingUrl: null,
      analysis: { vapiCallId: "vapi_9" },
    });
  });

  it("lives 7 days, and says so, so the UI can state the window truthfully", async () => {
    const res = await fetch(`${base}/api/calls/call_1/recording-url?share=1`);
    const body = (await res.json()) as { url: string; expiresInDays: number };
    expect(ttlSecondsOf(body.url)).toBe(7 * 24 * 60 * 60);
    expect(body.expiresInDays).toBe(7);
  });

  it("outlives the dashboard's own token, which is the whole point", async () => {
    const owner = (await (await fetch(`${base}/api/calls/call_1/recording-url`)).json()) as {
      url: string;
      expiresInDays?: number;
    };
    const shared = (await (
      await fetch(`${base}/api/calls/call_1/recording-url?share=1`)
    ).json()) as { url: string };
    expect(ttlSecondsOf(shared.url)).toBeGreaterThan(ttlSecondsOf(owner.url));
    // No expiry claim on the dashboard link — nothing is being shared.
    expect(owner.expiresInDays).toBeUndefined();
  });

  it("still 404s for a call that isn't the caller's — sharing isn't a way in", async () => {
    h.callLogFindFirst.mockResolvedValue(null);
    const res = await fetch(`${base}/api/calls/someone-elses/recording-url?share=1`);
    expect(res.status).toBe(404);
  });

  it("carries no ?download=1, so the recipient hears it instead of saving it", async () => {
    const res = await fetch(`${base}/api/calls/call_1/recording-url?share=1`);
    const { url } = (await res.json()) as { url: string };
    expect(url).not.toContain("download");
  });
});

// Downloads used to be named after the JWT path segment: a 200-char blob with no extension.
describe("GET /recording-file/:token?download=1 — filename", () => {
  /** Serve a tiny fake recording so the response reaches the header stage. */
  const serveAudio = (callerName: string, createdAt: string, contentType = "audio/wav") => {
    h.callLogFindFirst.mockResolvedValue({
      recordingUrl: "https://storage.test/rec",
      analysis: {},
      callerName,
      createdAt: new Date(createdAt),
    });
    h.fetchVapiRecording.mockResolvedValue(null);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) =>
        String(url).startsWith("https://storage.test")
          ? new Response(new Uint8Array([1, 2, 3]), {
              status: 200,
              headers: { "content-type": contentType },
            })
          : realFetch(url),
      ),
    );
  };
  const realFetch = globalThis.fetch;
  afterAll(() => vi.unstubAllGlobals());

  const disposition = async (query: string) => {
    const token = signRecording("call_1", "b_acme", "12h");
    const res = await realFetch(`${base}/api/calls/recording-file/${token}${query}`);
    return res.headers.get("content-disposition") ?? "";
  };

  it("streams inline for the player, so seeking still works", async () => {
    serveAudio("Browser Test", "2026-08-07T07:46:00.000Z");
    expect(await disposition("")).toBe("inline");
  });

  it("attaches a readable filename when download=1", async () => {
    serveAudio("Browser Test", "2026-08-07T07:46:00.000Z");
    expect(await disposition("?download=1")).toBe(
      'attachment; filename="hello22-call-browser-test-2026-08-07-0746.wav"',
    );
  });

  it("survives a caller name that would break the header", async () => {
    // A quote would terminate the header value; a slash would look like a path.
    serveAudio('Bad"/\\Name', "2026-08-07T07:46:00.000Z");
    const d = await disposition("?download=1");
    expect(d).toBe('attachment; filename="hello22-call-bad-name-2026-08-07-0746.wav"');
    expect(d).not.toContain('\\');
  });

  it("falls back to just the date when the name has no usable characters", async () => {
    serveAudio("नेपाली", "2026-08-07T07:46:00.000Z");
    expect(await disposition("?download=1")).toBe(
      'attachment; filename="hello22-call-2026-08-07-0746.wav"',
    );
  });

  it("uses the extension the upstream actually served, not a hardcoded .wav", async () => {
    serveAudio("Browser Test", "2026-08-07T07:46:00.000Z", "audio/mpeg");
    expect(await disposition("?download=1")).toContain(".mp3");
  });
});
