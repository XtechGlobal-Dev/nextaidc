import { describe, it, expect, vi, beforeEach } from "vitest";

/* ------------------------------------------------------------------ *
 *  Unsubscribe feature — service-level coverage.
 *  The email import graph pulls in env (which normally validates real
 *  process.env and can process.exit), Prisma, settings and nodemailer.
 *  Stub them all so the graph never touches a real DB / SMTP server.
 * ------------------------------------------------------------------ */

interface SentMail {
  html: string;
  text?: string;
  headers?: Record<string, string>;
}

const h = vi.hoisted(() => ({
  sendMail: vi.fn(async (_opts: SentMail) => ({ messageId: "test" })),
  userFindUnique: vi.fn(),
  templateFindUnique: vi.fn(async () => null), // fall back to code defaults
  settingFindMany: vi.fn(async () => []), // default branding (header/footer)
}));

vi.mock("../env.js", () => ({
  // Brand hosts resolve against these; the real module exports them, so a
  // mock that omits them fails to link for anything importing brandUrls.
  platformDomain: "hello22.ai",
  platformDomains: ["hello22.ai"],
  allowUnverifiedBrandDomains: false,
  canonicalApiBaseUrl: "https://api.test",
  env: { JWT_SECRET: "test-secret-abcdefgh", JWT_EXPIRES_IN: "7d" },
  appBaseUrl: "https://app.test",
  publicApiBaseUrl: "https://api.test",
}));

vi.mock("../prisma.js", () => ({
  prisma: {
    // No brand knows the address: the platform's own people are looked up in Main.
    customerDirectory: { findFirst: async () => null },
    user: { findUnique: h.userFindUnique, update: vi.fn() },
    emailTemplate: { findUnique: h.templateFindUnique },
    platformSetting: { findMany: h.settingFindMany },
  },
}));
vi.mock("./tenantDb.js", async () =>
  (await import("../test/tenantDbFake.js")).tenantDbFake({}),
);

vi.mock("./settings.js", () => ({
  integrationsStatus: () => ({ email: true }),
  // The transport gate is brand-aware now: it asks whether the integration is
  // configured for a given tenant rather than only for the platform.
  integrationConfiguredFor: () => true,
  getEffective: (key: string) => {
    const map: Record<string, string> = {
      "branding.appName": "Hello22",
      "smtp.from": "Hello22 <support@hello22.ai>",
      "smtp.host": "smtp.test",
      "smtp.port": "587",
      "smtp.user": "u",
      "smtp.pass": "p",
      "smtp.supportInbox": "",
    };
    return map[key] ?? "";
  },
}));

vi.mock("nodemailer", () => ({
  default: { createTransport: () => ({ sendMail: h.sendMail }) },
}));

import jwt from "jsonwebtoken";
import { signUnsubscribe, verifyUnsubscribe } from "../lib/jwt.js";
import { isUnsubscribable, renderEmail } from "./emailTemplates.js";
import { sendTemplate } from "./email.js";

/** The single mail captured by the stubbed transport for the current test. */
const lastMail = (): SentMail => {
  const call = h.sendMail.mock.calls.at(-1);
  if (!call) throw new Error("sendMail was not called");
  return call[0];
};

beforeEach(() => {
  vi.clearAllMocks();
  h.templateFindUnique.mockResolvedValue(null);
  h.settingFindMany.mockResolvedValue([]);
});

describe("unsubscribe token", () => {
  it("round-trips a user id and never expires", () => {
    const token = signUnsubscribe("user_123");
    expect(verifyUnsubscribe(token)).toBe("user_123");
  });

  it("rejects a token minted for a different purpose", () => {
    // A login/oauth token must never be accepted as an unsubscribe token.
    const wrong = jwt.sign({ sub: "user_123", kind: "oauth_state" }, "test-secret-abcdefgh");
    expect(() => verifyUnsubscribe(wrong)).toThrow();
  });
});

describe("isUnsubscribable", () => {
  it("marks notification emails unsubscribable", () => {
    expect(isUnsubscribable("call_summary")).toBe(true);
    expect(isUnsubscribable("usage_threshold")).toBe(true);
    expect(isUnsubscribable("grace_started")).toBe(true);
    expect(isUnsubscribable("grace_final_warning")).toBe(true);
  });

  it("never marks security / account emails unsubscribable", () => {
    expect(isUnsubscribable("email_verification")).toBe(false);
    expect(isUnsubscribable("password_reset")).toBe(false);
    expect(isUnsubscribable("account_suspended")).toBe(false);
    expect(isUnsubscribable("staff_welcome")).toBe(false);
  });
});

describe("renderEmail unsubscribe footer", () => {
  it("appends the unsubscribe link (html + text) when a url is provided", async () => {
    const url = "https://api.test/api/unsubscribe?token=abc";
    const rendered = await renderEmail("call_summary", { caller_name: "Jo" }, { unsubscribeUrl: url });
    expect(rendered).not.toBeNull();
    expect(rendered!.html).toContain(url);
    expect(rendered!.html.toLowerCase()).toContain("unsubscribe");
    expect(rendered!.text).toContain(`Unsubscribe from these emails: ${url}`);
  });

  it("omits the unsubscribe link when no url is provided", async () => {
    const rendered = await renderEmail("call_summary", { caller_name: "Jo" });
    expect(rendered!.html.toLowerCase()).not.toContain("unsubscribe");
    expect(rendered!.text.toLowerCase()).not.toContain("unsubscribe");
  });
});

describe("sendTemplate opt-out gating", () => {
  it("skips delivery entirely for an opted-out recipient", async () => {
    h.userFindUnique.mockResolvedValue({ id: "u1", emailOptOutAt: new Date("2026-01-01") });
    const sent = await sendTemplate("call_summary", "opted@out.com", { caller_name: "Jo" });
    expect(sent).toBe(false);
    expect(h.sendMail).not.toHaveBeenCalled();
  });

  it("sends with a tokenized link + List-Unsubscribe headers for a subscribed recipient", async () => {
    h.userFindUnique.mockResolvedValue({ id: "u1", emailOptOutAt: null });
    const sent = await sendTemplate("call_summary", "sub@scribed.com", { caller_name: "Jo" });
    expect(sent).toBe(true);
    expect(h.sendMail).toHaveBeenCalledTimes(1);
    const arg = lastMail();
    // One-click List-Unsubscribe headers present and well-formed.
    expect(arg.headers!["List-Unsubscribe"]).toMatch(/^<https:\/\/api\.test\/api\/unsubscribe\?token=.+>$/);
    expect(arg.headers!["List-Unsubscribe-Post"]).toBe("List-Unsubscribe=One-Click");
    // The same tokenized link is in the rendered body.
    expect(arg.html).toContain("/api/unsubscribe?token=");
    // And the token in the header actually verifies back to this user.
    const token = decodeURIComponent(arg.headers!["List-Unsubscribe"].match(/token=([^>]+)>/)![1]);
    expect(verifyUnsubscribe(token)).toBe("u1");
  });

  it("does NOT attach unsubscribe machinery to a security email", async () => {
    h.userFindUnique.mockResolvedValue({ id: "u1", emailOptOutAt: new Date() });
    // Even though this user is opted out, a password reset must still send and
    // must carry no unsubscribe header/link.
    const sent = await sendTemplate("password_reset", "u@x.com", { code: "123456", expiry_minutes: "10" });
    expect(sent).toBe(true);
    const arg = lastMail();
    expect(arg.headers).toBeUndefined();
    expect(arg.html.toLowerCase()).not.toContain("unsubscribe");
  });

  it("sends a notification with no unsubscribe link when the address isn't a known user", async () => {
    h.userFindUnique.mockResolvedValue(null);
    const sent = await sendTemplate("call_summary", "stranger@x.com", { caller_name: "Jo" });
    expect(sent).toBe(true);
    const arg = lastMail();
    expect(arg.headers).toBeUndefined();
    expect(arg.html.toLowerCase()).not.toContain("unsubscribe");
  });
});
