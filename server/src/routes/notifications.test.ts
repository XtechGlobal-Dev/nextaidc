import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";
import express from "express";
import type { Server } from "node:http";

// GET / and POST /test-summary go through sendValidated(), so a pass here also
// proves the live response matches the shared contract the frontend types against.

const h = vi.hoisted(() => ({
  listNotifications: vi.fn(),
  planeOf: vi.fn(),
  notificationCount: vi.fn(),
  callSummaryEmail: vi.fn(),
  getEntitlement: vi.fn(),
}));

vi.mock("../env.js", () => ({
  env: { JWT_SECRET: "test-secret-for-the-notifications-suite" },
}));
vi.mock("../middleware/auth.js", () => ({
  requireAuth: (req: any, _res: any, next: any) => {
    req.user = { sub: "user_1", brandId: null, role: "customer" };
    next();
  },
}));
vi.mock("../lib/roles.js", () => ({ isAdminRole: () => false }));
vi.mock("../lib/brandUrls.js", () => ({ brandDisplayName: () => "Test Brand" }));
vi.mock("../services/tenantDb.js", () => ({
  planeOf: h.planeOf,
  tenantFor: vi.fn(),
}));
vi.mock("../services/notifications.js", () => ({
  listNotifications: h.listNotifications,
  markNotificationRead: vi.fn(),
  markAllNotificationsRead: vi.fn(),
  clearNotifications: vi.fn(),
}));
vi.mock("../services/settings.js", () => ({
  integrationsStatus: () => ({ email: true, sms: false, whatsapp: false }),
}));
vi.mock("../services/trial.js", () => ({
  getPlanFeatures: vi.fn(async () => ({ sms: false, whatsapp: false })),
  getEntitlement: h.getEntitlement,
  entitlementError: () => ({ code: "blocked", message: "Blocked" }),
}));
vi.mock("../services/email.js", () => ({ callSummaryEmail: h.callSummaryEmail }));
vi.mock("../services/sms.js", () => ({
  isTwilioConfigured: () => false,
  callSummarySms: vi.fn(),
  describeSmsError: () => "SMS failed",
}));
vi.mock("../services/whatsapp.js", () => ({
  isWhatsAppConfigured: () => false,
  callSummaryWhatsApp: vi.fn(),
}));

const { default: router } = await import("./notifications.routes.js");

let server: Server;
let base: string;
const app = express();
app.use(express.json());
app.use("/api/notifications", router);
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
  h.getEntitlement.mockResolvedValue({ blocked: false });
});

describe("GET /api/notifications", () => {
  it("returns notifications + unreadCount matching the shared contract", async () => {
    const createdAt = new Date("2026-01-01T00:00:00.000Z");
    h.planeOf.mockResolvedValue({ notification: { count: h.notificationCount } });
    h.notificationCount.mockResolvedValue(2);
    h.listNotifications.mockResolvedValue([
      {
        id: "n1",
        userId: "user_1",
        type: "missed_call",
        title: "Missed call",
        message: "You missed a call",
        link: null,
        read: false,
        createdAt,
      },
    ]);

    const res = await fetch(`${base}/api/notifications`);
    expect(res.status).toBe(200);
    const body = await res.json();
    // Date → ISO string and `userId` stripped both prove sendValidated() sent the
    // parsed value, not the raw object.
    expect(body).toEqual({
      notifications: [
        {
          id: "n1",
          type: "missed_call",
          title: "Missed call",
          message: "You missed a call",
          link: null,
          read: false,
          createdAt: createdAt.toISOString(),
        },
      ],
      unreadCount: 2,
    });
  });
});

describe("POST /api/notifications/test-summary", () => {
  it("sends a test email and echoes the destination", async () => {
    h.callSummaryEmail.mockResolvedValue(undefined);
    const res = await fetch(`${base}/api/notifications/test-summary`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ channel: "email", to: "owner@test.com" }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, to: "owner@test.com" });
    expect(h.callSummaryEmail).toHaveBeenCalled();
  });
});
