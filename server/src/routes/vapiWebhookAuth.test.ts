import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";
import express from "express";
import type { Server } from "node:http";

/* ------------------------------------------------------------------ *
 *  Vapi call webhook must authenticate.
 *
 *  POST /api/calls/webhook/vapi is public and, on the end-of-call report,
 *  records billable minutes and can auto-charge. Without auth, anyone who
 *  knows a customer's assistantId could POST a fake "call ended" event and
 *  drain that customer's minutes (or trigger a renewal charge).
 *
 *  The fix: when a webhook secret is configured, Vapi echoes it in the
 *  `x-vapi-secret` header and we require a match. These tests assert a forged
 *  request is rejected BEFORE any usage is recorded.
 * ------------------------------------------------------------------ */

const h = vi.hoisted(() => ({
  conversionFindFirst: vi.fn(),
  callLogCreate: vi.fn(),
  callLogUpdate: vi.fn(),
  userFindUnique: vi.fn(),
  appointmentCount: vi.fn(),
  recordUsage: vi.fn(async () => {}),
  settleAfterCall: vi.fn(async () => {}),
  enforceTrialMinutes: vi.fn(async () => {}),
  deliverCallToCrm: vi.fn(),
  notify: vi.fn(),
  settings: {} as Record<string, string>,
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
    JWT_SECRET: "test-secret-for-vapi-webhook-suite",
    APP_URL: "https://app.test",
    PUBLIC_API_URL: "https://api.test",
    VAPI_SERVER_URL: "https://api.test",
    SHARE_LINK_BASE_URL: "",
    CORS_ORIGIN: "https://app.test",
  },
}));

vi.mock("../prisma.js", () => ({
  prisma: {
    conversion: { findFirst: h.conversionFindFirst, findUnique: vi.fn(), create: vi.fn() },
    callShare: { upsert: vi.fn(async () => ({})) },
    user: { findUnique: h.userFindUnique },
  },
}));
// Calls and appointments are written to the brand's own database; this stands one in.
vi.mock("../services/tenantDb.js", async () =>
  (await import("../test/tenantDbFake.js")).tenantDbFake({ callLog: { create: h.callLogCreate, update: h.callLogUpdate }, appointment: { count: h.appointmentCount } }),
);
// Every customer belongs to a brand. The call's brand decides which database
// it is written to and which brand its recording link is signed for.
vi.mock("../services/customerDirectory.js", () => ({ brandIdForOwner: async () => "b_acme" }));
vi.mock("../services/settings.js", () => ({
  integrationsStatus: () => ({ email: false, openai: false, perfex: false }),
  getEffective: (key: string) => h.settings[key] ?? "",
}));

vi.mock("../services/trial.js", () => ({
  recordUsage: h.recordUsage,
  settleAfterCall: h.settleAfterCall,
  getPlanFeatures: vi.fn(async () => ({ sms: false, whatsapp: false, customCrm: false })),
  getCallDurationCap: vi.fn(async () => 0),
}));
vi.mock("../services/billing.js", () => ({ enforceTrialMinutes: h.enforceTrialMinutes }));
vi.mock("../services/provisioning.js", () => ({ settleAfterCall: h.settleAfterCall }));
vi.mock("../services/webhook.js", () => ({ deliverCallToCrm: h.deliverCallToCrm }));
vi.mock("../services/notifications.js", () => ({ notify: h.notify }));
vi.mock("../services/booking.js", () => ({
  maybeCreateCalendarBooking: vi.fn(async () => ({ ok: false, skipped: "test" })),
}));
vi.mock("../services/callWrapUp.js", () => ({ scheduleWrapUp: vi.fn(), cancelWrapUp: vi.fn() }));
vi.mock("../services/email.js", () => ({ callSummaryEmail: vi.fn() }));
vi.mock("../services/sms.js", () => ({ isTwilioConfigured: () => false, callSummarySms: vi.fn() }));
vi.mock("../services/whatsapp.js", () => ({ isWhatsAppConfigured: () => false, callSummaryWhatsApp: vi.fn() }));
vi.mock("../services/vapi.js", () => ({ getCallRecordingUrl: vi.fn(async () => null), fetchVapiRecording: vi.fn() }));
vi.mock("../middleware/auth.js", () => ({
  requireAuth: (_r: any, _s: any, n: any) => n(),
  // These routes now sit behind requireCustomerAccount too; the role rules are
  // covered in brandAccess.test.ts, so wave it through here.
  requireCustomerAccount: (_r: any, _s: any, n: any) => n(),
}));
vi.mock("../middleware/trial.js", () => ({ validateTrial: (_r: any, _s: any, n: any) => n() }));
vi.mock("../services/summary.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../services/summary.js")>()),
  summarizeCallTranscript: vi.fn(async () => ""),
  classifyCallIntent: vi.fn(async () => ({ category: "", contactCaptured: false })),
  translateText: vi.fn(async () => ""),
  translateTranscript: vi.fn(async () => null),
}));

const { default: router } = await import("./calls.routes.js");

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

const SECRET = "s3cr3t-vapi-webhook-value";

/** A forged end-of-call report claiming a 10-minute call for a known assistant. */
const FAKE_REPORT = {
  message: {
    type: "end-of-call-report",
    call: { id: "fake-call-001", assistantId: "asst_victim" },
    durationSeconds: 600,
  },
};

async function postWebhook(headers: Record<string, string> = {}) {
  return fetch(`${base}/api/calls/webhook/vapi`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(FAKE_REPORT),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  h.settings = {};
  // A real, matchable conversion for the targeted assistant.
  h.conversionFindFirst.mockResolvedValue({ id: "conv_1", userId: "user_1", agentConfig: {} });
  h.callLogCreate.mockResolvedValue({
    id: "call_1",
    conversionId: "conv_1",
    type: "Phone",
    outcome: "completed",
    callerName: null,
    callerNumber: null,
    durationSec: 600,
    summary: null,
  });
  h.appointmentCount.mockResolvedValue(0);
});

describe("POST /api/calls/webhook/vapi — authentication", () => {
  it("rejects a forged report with 401 when the secret is missing (no minutes deducted)", async () => {
    h.settings = { "vapi.webhookSecret": SECRET };

    const res = await postWebhook(); // no x-vapi-secret header
    expect(res.status).toBe(401);

    // Give any (wrongly) fired async work a beat, then confirm nothing ran.
    await new Promise((r) => setTimeout(r, 30));
    expect(h.recordUsage).not.toHaveBeenCalled();
    expect(h.callLogCreate).not.toHaveBeenCalled();
    expect(h.conversionFindFirst).not.toHaveBeenCalled();
  });

  it("rejects a report bearing the wrong secret with 401", async () => {
    h.settings = { "vapi.webhookSecret": SECRET };

    const res = await postWebhook({ "x-vapi-secret": "wrong-value" });
    expect(res.status).toBe(401);
    await new Promise((r) => setTimeout(r, 30));
    expect(h.recordUsage).not.toHaveBeenCalled();
  });

  it("accepts a report with the correct secret and records the usage", async () => {
    h.settings = { "vapi.webhookSecret": SECRET };

    const res = await postWebhook({ "x-vapi-secret": SECRET });
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ received: true });

    await vi.waitFor(() => expect(h.recordUsage).toHaveBeenCalledTimes(1));
    expect(h.recordUsage).toHaveBeenCalledWith("user_1", 600);
  });

  it("stays open when no secret is configured (local/dev back-compat)", async () => {
    h.settings = {}; // no vapi.webhookSecret

    const res = await postWebhook(); // no header at all
    expect(res.status).toBe(200);
    await vi.waitFor(() => expect(h.recordUsage).toHaveBeenCalledTimes(1));
    expect(h.recordUsage).toHaveBeenCalledWith("user_1", 600);
  });
});
