import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";
import express from "express";
import type { Server } from "node:http";

// PATCH /api/calls/:id — a web call's late enrichment (summary, recording). Must stay scoped to the caller's own calls.

const h = vi.hoisted(() => ({
  callLogFindFirst: vi.fn(),
  callLogUpdate: vi.fn(),
  conversionFindUnique: vi.fn(),
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
  env: { JWT_SECRET: "test-secret-for-call-patch-suite", PUBLIC_API_URL: "https://api.test", VAPI_SERVER_URL: "https://api.test", JWT_EXPIRES_IN: "7d" },
}));
vi.mock("../prisma.js", () => ({
  prisma: {
    conversion: { findUnique: h.conversionFindUnique, create: vi.fn() },
    user: { findUnique: vi.fn() },
  },
}));
// The customer's calls and appointments are in their brand's own database;
// this stands one in.
vi.mock("../services/tenantDb.js", async () =>
  (await import("../test/tenantDbFake.js")).tenantDbFake({ callLog: { findFirst: h.callLogFindFirst, update: h.callLogUpdate }, appointment: { count: async () => 0 } }),
);
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
vi.mock("../services/vapi.js", () => ({ getCallRecordingUrl: vi.fn(), fetchVapiRecording: vi.fn() }));
vi.mock("../services/trial.js", () => ({ recordUsage: vi.fn(), settleAfterCall: vi.fn(), getPlanFeatures: vi.fn(async () => ({})), getCallDurationCap: vi.fn(async () => 0) }));
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
});

async function patchCall(id: string, body: unknown) {
  return fetch(`${base}/api/calls/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

/** Second half of the partitioned primary key, fixed so the composite-key
 *  assertions below are exact. */
const CREATED_AT = new Date("2026-09-01T10:00:00.000Z");

describe("PATCH /api/calls/:id — enrich a saved call", () => {
  it("updates the summary on the caller's own call", async () => {
    h.callLogFindFirst.mockResolvedValue({ id: "call_1", createdAt: CREATED_AT });
    h.callLogUpdate.mockResolvedValue({ id: "call_1", summary: "AI summary" });

    const res = await patchCall("call_1", { summary: "AI summary" });
    expect(res.status).toBe(200);
    // call_logs is partitioned on createdAt: composite key, and passing the timestamp keeps the write to one partition.
    expect(h.callLogUpdate).toHaveBeenCalledWith({
      where: { id_createdAt: { id: "call_1", createdAt: CREATED_AT } },
      data: { summary: "AI summary" },
    });
  });

  it("updates summary + recordingUrl together", async () => {
    h.callLogFindFirst.mockResolvedValue({ id: "call_1", createdAt: CREATED_AT });
    h.callLogUpdate.mockResolvedValue({ id: "call_1" });

    await patchCall("call_1", { summary: "S", recordingUrl: "https://api.test/rec" });
    expect(h.callLogUpdate).toHaveBeenCalledWith({
      where: { id_createdAt: { id: "call_1", createdAt: CREATED_AT } },
      data: { recordingUrl: "https://api.test/rec", summary: "S" },
    });
  });

  it("404s (and never updates) a call the caller doesn't own", async () => {
    h.callLogFindFirst.mockResolvedValue(null);
    const res = await patchCall("someone-elses", { summary: "hax" });
    expect(res.status).toBe(404);
    expect(h.callLogUpdate).not.toHaveBeenCalled();
  });
});
