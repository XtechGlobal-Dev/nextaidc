import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";
import express from "express";
import type { Server } from "node:http";

// PATCH /api/profile forwarding contract: mode passthrough, confirmed boolean →
// confirmedAt mapping, enum validation. Real Express; env/prisma/auth stubbed.

const cap = vi.hoisted(() => ({ data: null as Record<string, unknown> | null }));

vi.mock("../env.js", () => ({
  // Brand hosts resolve against these; the real module exports them, so a
  // mock that omits them fails to link for anything importing brandUrls.
  platformDomain: "hello22.ai",
  platformDomains: ["hello22.ai"],
  allowUnverifiedBrandDomains: false,
  canonicalApiBaseUrl: "https://api.test",
  env: {
    JWT_SECRET: "test-secret-abcdefgh",
    JWT_EXPIRES_IN: "7d",
    PORT: 4000,
    CORS_ORIGIN: "http://localhost:5174",
    APP_URL: "",
    SMTP_FROM: "x <s@x.com>",
    VAPI_SERVER_URL: "",
    PUBLIC_API_URL: "",
  },
  appBaseUrl: "https://app.test",
  publicApiBaseUrl: "https://api.test",
  corsOrigins: ["http://localhost:5174"],
}));

vi.mock("../prisma.js", () => ({
  prisma: {
    user: {
      update: vi.fn(async () => ({})),
      findUnique: vi.fn(async () => ({ email: "u@x.com", fullName: "U" })),
    },
    profile: {
      update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        cap.data = data;
        return { id: "p1", userId: "u1", ...data };
      }),
      findUnique: vi.fn(async () => ({ id: "p1", userId: "u1" })),
      create: vi.fn(async () => ({ id: "p1", userId: "u1" })),
    },
  },
}));
vi.mock("../services/tenantDb.js", async () =>
  (await import("../test/tenantDbFake.js")).tenantDbFake({}),
);

vi.mock("../middleware/auth.js", () => ({
  requireAuth: (req: { user?: unknown }, _res: unknown, next: () => void) => {
    (req as { user: unknown }).user = { sub: "u1", role: "USER", email: "u@x.com" };
    next();
  },
}));

import profileRouter from "./profile.routes.js";
import { errorHandler } from "../middleware/error.js";

const app = express();
app.use(express.json());
app.use("/api/profile", profileRouter);
app.use(errorHandler);

let server: Server;
let base: string;

async function patchProfile(body: unknown): Promise<{ status: number }> {
  const res = await fetch(`${base}/api/profile`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status };
}

beforeEach(async () => {
  cap.data = null;
  if (!server) {
    await new Promise<void>((resolve) => {
      server = app.listen(0, () => {
        const addr = server.address();
        base = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
        resolve();
      });
    });
  }
});

afterAll(() => server?.close());

describe("PATCH /api/profile — forwarding", () => {
  it("persists forwardingMode verbatim", async () => {
    const { status } = await patchProfile({ forwardingMode: "overflow" });
    expect(status).toBe(200);
    expect(cap.data?.forwardingMode).toBe("overflow");
    // Untouched fields must NOT appear in the update payload.
    expect(cap.data && "forwardingConfirmedAt" in cap.data).toBe(false);
  });

  it("maps forwardingConfirmed=true → a forwardingConfirmedAt Date", async () => {
    await patchProfile({ forwardingConfirmed: true });
    expect(cap.data?.forwardingConfirmedAt).toBeInstanceOf(Date);
  });

  it("maps forwardingConfirmed=false → forwardingConfirmedAt null (clears it)", async () => {
    await patchProfile({ forwardingConfirmed: false });
    expect(cap.data?.forwardingConfirmedAt).toBeNull();
  });

  it("accepts mode + confirm together", async () => {
    await patchProfile({ forwardingMode: "all", forwardingConfirmed: true });
    expect(cap.data?.forwardingMode).toBe("all");
    expect(cap.data?.forwardingConfirmedAt).toBeInstanceOf(Date);
  });

  it("rejects an invalid forwardingMode with 400 and no DB write", async () => {
    const { status } = await patchProfile({ forwardingMode: "bogus" });
    expect(status).toBe(400);
    expect(cap.data).toBeNull();
  });

  it("still saves businessNumber (the forward-from number)", async () => {
    await patchProfile({ businessNumber: "+61400111222" });
    expect(cap.data?.businessNumber).toBe("+61400111222");
  });
});
