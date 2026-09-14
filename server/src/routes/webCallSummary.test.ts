import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";
import express from "express";
import type { Server } from "node:http";

// Browser calls use an inline Vapi assistant, so no end-of-call webhook fires — for
// months that meant no summary at all. These assert it leaves via POST /api/calls.

const h = vi.hoisted(() => ({
  conversionFindUnique: vi.fn(),
  callLogCreate: vi.fn(),
  callLogUpdate: vi.fn(),
  userFindUnique: vi.fn(),
  appointmentCount: vi.fn(),
  callSummaryEmail: vi.fn(),
  callSummarySms: vi.fn(),
  callSummaryWhatsApp: vi.fn(),
  getCallRecordingUrl: vi.fn(),
  emailConfigured: true,
  twilioConfigured: false,
  whatsappConfigured: false,
  settings: {} as Record<string, string>,
}));

// Mocking a module replaces ALL of its exports, so every export something in
// this route's import graph reads has to be present.
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
    JWT_SECRET: "test-secret-for-web-call-summary-suite",
    APP_URL: "https://app.test",
    PUBLIC_API_URL: "https://api.test",
    VAPI_SERVER_URL: "https://api.test",
    SHARE_LINK_BASE_URL: "",
    CORS_ORIGIN: "https://app.test",
  },
}));

vi.mock("../prisma.js", () => ({
  prisma: {
    conversion: { findUnique: h.conversionFindUnique, create: vi.fn() },
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
  integrationsStatus: () => ({ email: h.emailConfigured, openai: false, perfex: false }),
  getEffective: (key: string) => h.settings[key] ?? "",
}));
vi.mock("../services/email.js", () => ({ callSummaryEmail: h.callSummaryEmail }));
vi.mock("../services/sms.js", () => ({
  isTwilioConfigured: () => h.twilioConfigured,
  callSummarySms: h.callSummarySms,
}));
vi.mock("../services/whatsapp.js", () => ({
  isWhatsAppConfigured: () => h.whatsappConfigured,
  callSummaryWhatsApp: h.callSummaryWhatsApp,
}));
vi.mock("../services/vapi.js", () => ({
  getCallRecordingUrl: h.getCallRecordingUrl,
  fetchVapiRecording: vi.fn(),
}));
vi.mock("../services/webhook.js", () => ({ deliverCallToCrm: vi.fn() }));
vi.mock("../services/notifications.js", () => ({ notify: vi.fn() }));
vi.mock("../services/booking.js", () => ({
  maybeCreateCalendarBooking: vi.fn(async () => ({ ok: false, skipped: "test" })),
}));
vi.mock("../services/billing.js", () => ({ enforceTrialMinutes: vi.fn(async () => {}) }));
vi.mock("../services/trial.js", () => ({
  recordUsage: vi.fn(async () => {}),
  settleAfterCall: vi.fn(async () => {}),
  getPlanFeatures: vi.fn(async () => ({ sms: true, whatsapp: true, customCrm: false })),
  getCallDurationCap: vi.fn(async () => 0),
}));
vi.mock("../services/provisioning.js", () => ({ settleAfterCall: vi.fn(async () => {}) }));
vi.mock("../services/callWrapUp.js", () => ({ scheduleWrapUp: vi.fn(), cancelWrapUp: vi.fn() }));
// Keep the real transcript helpers (intent resolution depends on them); stub only
// the LLM round-trips.
vi.mock("../services/summary.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../services/summary.js")>()),
  summarizeCallTranscript: vi.fn(async () => ""),
  classifyCallIntent: vi.fn(async () => ({ category: "", contactCaptured: true })),
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

const WEB_CALL_BODY = {
  type: "Web",
  callerName: "Browser Test",
  durationSec: 42,
  outcome: "completed",
  summary: "Caller asked about opening hours.",
  transcript: [
    { role: "agent", text: "Thanks for calling. How can I help?" },
    { role: "caller", text: "What time do you open on Sunday?" },
  ],
  analysis: { summary: "Caller asked about opening hours.", vapiCallId: "vapi_call_9" },
};

/** The stored row the route hands to the notification layer. */
function createdCall(overrides: Record<string, unknown> = {}) {
  return {
    id: "call_1",
    conversionId: "conv_1",
    type: "Web",
    callerName: "Browser Test",
    callerNumber: "",
    outcome: "completed",
    summary: WEB_CALL_BODY.summary,
    durationSec: 42,
    recordingUrl: null,
    ...overrides,
  };
}

async function postWebCall(body: unknown = WEB_CALL_BODY) {
  return fetch(`${base}/api/calls`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  h.emailConfigured = true;
  h.twilioConfigured = false;
  h.whatsappConfigured = false;
  h.settings = {};
  // Legacy-free config: every automation key present, email summary on.
  h.conversionFindUnique.mockResolvedValue({
    id: "conv_1",
    agentConfig: {
      automations: {
        ownerEmailSummary: true,
        ownerSmsSummary: false,
        ownerWhatsAppSummary: false,
        summaryEmail: "",
        summarySmsNumber: "",
        summaryWhatsAppNumber: "",
        reportLanguage: "",
        conversationLinkValidityHours: 720,
      },
    },
  });
  h.callLogCreate.mockImplementation(async ({ data }: any) => createdCall({ publicId: data.publicId }));
  h.callLogUpdate.mockResolvedValue(createdCall());
  h.userFindUnique.mockResolvedValue({ email: "owner@example.com", profile: { mobile: "", businessName: "Acme" } });
  h.appointmentCount.mockResolvedValue(0);
  h.getCallRecordingUrl.mockResolvedValue(null);
});

describe("POST /api/calls — owner summary for web (test) calls", () => {
  it("emails the owner the summary, transcript and a recording link", async () => {
    const res = await postWebCall();
    expect(res.status).toBe(200);

    await vi.waitFor(() => expect(h.callSummaryEmail).toHaveBeenCalledTimes(1));
    const sent = h.callSummaryEmail.mock.calls[0][0];
    expect(sent.ownerEmail).toBe("owner@example.com");
    expect(sent.callerName).toBe("Browser Test");
    expect(sent.summary).toBe(WEB_CALL_BODY.summary);
    expect(sent.transcript).toContain("What time do you open on Sunday?");
    // No stored URL, but the Vapi call id lets the proxy stream it — the link is on
    // our domain and carries a signed token, not the raw call id.
    expect(sent.recordingUrl).toMatch(
      /^https:\/\/api\.test\/api\/calls\/recording-file\/eyJ[\w.-]+$/,
    );
    expect(sent.recordingUrl).not.toContain("/recording-file/call_1");
  });

  it("prefers the owner's summary-email override over their account email", async () => {
    h.conversionFindUnique.mockResolvedValue({
      id: "conv_1",
      agentConfig: {
        automations: {
          ownerEmailSummary: true,
          ownerSmsSummary: false,
          ownerWhatsAppSummary: false,
          summaryEmail: "reports@example.com",
          summarySmsNumber: "",
          summaryWhatsAppNumber: "",
          reportLanguage: "",
          conversationLinkValidityHours: 720,
        },
      },
    });

    await postWebCall();

    await vi.waitFor(() => expect(h.callSummaryEmail).toHaveBeenCalledTimes(1));
    expect(h.callSummaryEmail.mock.calls[0][0].ownerEmail).toBe("reports@example.com");
  });

  it("sends nothing when the owner turned the email summary off", async () => {
    h.conversionFindUnique.mockResolvedValue({
      id: "conv_1",
      agentConfig: {
        automations: {
          ownerEmailSummary: false,
          ownerSmsSummary: false,
          ownerWhatsAppSummary: false,
          summaryEmail: "",
          summarySmsNumber: "",
          summaryWhatsAppNumber: "",
          reportLanguage: "",
          conversationLinkValidityHours: 720,
        },
      },
    });

    const res = await postWebCall();
    expect(res.status).toBe(200);
    // Give the fire-and-forget channels a chance to misbehave before asserting.
    await new Promise((r) => setTimeout(r, 30));
    expect(h.callSummaryEmail).not.toHaveBeenCalled();
  });

  it("stays silent when email sending isn't configured at all", async () => {
    h.emailConfigured = false;

    const res = await postWebCall();
    expect(res.status).toBe(200);
    await new Promise((r) => setTimeout(r, 30));
    expect(h.callSummaryEmail).not.toHaveBeenCalled();
  });

  it("gives the call a public id so the 'More info' link has somewhere to point", async () => {
    await postWebCall();
    const data = h.callLogCreate.mock.calls[0][0].data;
    expect(typeof data.publicId).toBe("string");
    expect(data.publicId.length).toBeGreaterThan(0);
    // 720h validity → a concrete expiry rather than "never".
    expect(data.shareExpiresAt).toBeInstanceOf(Date);
  });

  it("texts the summary, with a working 'More info' link, when SMS is on", async () => {
    h.twilioConfigured = true;
    h.settings = { "twilio.fromNumber": "+61400999888" };
    h.conversionFindUnique.mockResolvedValue({
      id: "conv_1",
      agentConfig: {
        automations: {
          ownerEmailSummary: false,
          ownerSmsSummary: true,
          ownerWhatsAppSummary: false,
          summaryEmail: "",
          summarySmsNumber: "+61400111222",
          summaryWhatsAppNumber: "",
          smsIncludeConversationLink: true,
          reportLanguage: "",
          conversationLinkValidityHours: 720,
        },
      },
    });

    await postWebCall();

    await vi.waitFor(() => expect(h.callSummarySms).toHaveBeenCalledTimes(1));
    const sent = h.callSummarySms.mock.calls[0][0];
    expect(sent.to).toBe("+61400111222");
    expect(sent.summary).toBe(WEB_CALL_BODY.summary);
    // The link must resolve to the public id we actually stored, not a blank slug.
    const publicId = h.callLogCreate.mock.calls[0][0].data.publicId;
    expect(sent.conversationUrl).toBe(`https://api.test/c/${publicId}`);
  });

  it("doesn't text when no SMS sender is configured, toggle on or not", async () => {
    h.twilioConfigured = true;
    h.settings = {}; // no twilio.fromNumber
    h.conversionFindUnique.mockResolvedValue({
      id: "conv_1",
      agentConfig: {
        automations: {
          ownerEmailSummary: false,
          ownerSmsSummary: true,
          ownerWhatsAppSummary: false,
          summaryEmail: "",
          summarySmsNumber: "+61400111222",
          summaryWhatsAppNumber: "",
          reportLanguage: "",
          conversationLinkValidityHours: 720,
        },
      },
    });

    await postWebCall();
    await new Promise((r) => setTimeout(r, 30));
    expect(h.callSummarySms).not.toHaveBeenCalled();
  });
});
