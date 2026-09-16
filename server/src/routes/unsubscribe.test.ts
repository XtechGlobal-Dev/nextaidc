import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";
import express from "express";
import type { Server } from "node:http";

// End-to-end /api/unsubscribe over a real Express server; an in-memory user stands
// in for the DB so the opt-out flag can be asserted.

const db = vi.hoisted(() => ({
  // Mutable stand-in row; update() writes here, findUnique() reads it.
  user: { id: "u1", email: "user@test.com", emailOptOutAt: null as Date | null },
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
    user: {
      findUnique: vi.fn(async ({ where }: { where: { id?: string; email?: string } }) =>
        where.id === db.user.id || where.email === db.user.email ? { ...db.user } : null,
      ),
      update: vi.fn(async ({ data }: { data: { emailOptOutAt: Date | null } }) => {
        db.user.emailOptOutAt = data.emailOptOutAt;
        return { ...db.user };
      }),
    },
  },
}));

vi.mock("../services/settings.js", () => ({
  getEffective: (key: string) =>
    key === "branding.appName" ? "Hello22" : key === "smtp.from" ? "x <support@hello22.ai>" : "",
  integrationsStatus: () => ({ email: true }),
}));

import unsubscribeRouter from "./unsubscribe.routes.js";
import { signUnsubscribe } from "../lib/jwt.js";

const app = express();
app.use("/api/unsubscribe", unsubscribeRouter);
let server: Server;
let base: string;

async function start(): Promise<void> {
  await new Promise<void>((resolve) => {
    server = app.listen(0, () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      base = `http://127.0.0.1:${port}`;
      resolve();
    });
  });
}

beforeEach(() => {
  db.user.emailOptOutAt = null;
});

afterAll(() => {
  server?.close();
});

describe("GET /api/unsubscribe", () => {
  it("opts the user out and renders a confirmation page", async () => {
    await start();
    const token = signUnsubscribe("u1");
    const res = await fetch(`${base}/api/unsubscribe?token=${encodeURIComponent(token)}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const html = await res.text();
    expect(html.toLowerCase()).toContain("unsubscribed");
    expect(html).toContain("Re-subscribe");
    expect(db.user.emailOptOutAt).toBeInstanceOf(Date);
  });

  it("re-subscribes when resubscribe=1", async () => {
    db.user.emailOptOutAt = new Date();
    const token = signUnsubscribe("u1");
    const res = await fetch(`${base}/api/unsubscribe?token=${encodeURIComponent(token)}&resubscribe=1`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html.toLowerCase()).toContain("subscribed again");
    expect(db.user.emailOptOutAt).toBeNull();
  });

  it("returns 400 for an invalid token and does not touch the flag", async () => {
    const res = await fetch(`${base}/api/unsubscribe?token=garbage`);
    expect(res.status).toBe(400);
    expect(db.user.emailOptOutAt).toBeNull();
  });
});

describe("POST /api/unsubscribe (one-click)", () => {
  it("opts the user out and returns 200 text", async () => {
    const token = signUnsubscribe("u1");
    const res = await fetch(`${base}/api/unsubscribe?token=${encodeURIComponent(token)}`, {
      method: "POST",
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/plain");
    expect(db.user.emailOptOutAt).toBeInstanceOf(Date);
  });

  it("returns 400 for a missing/invalid token", async () => {
    const res = await fetch(`${base}/api/unsubscribe`, { method: "POST" });
    expect(res.status).toBe(400);
    expect(db.user.emailOptOutAt).toBeNull();
  });
});
