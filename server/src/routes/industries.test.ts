import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";
import express from "express";
import type { Server } from "node:http";

/* ------------------------------------------------------------------ *
 *  API contract pilot: this route's responses go through sendValidated()
 *  against the shared @shared/contracts/industries schemas, so a passing
 *  assertion here also confirms the live response matches the contract
 *  the frontend's src/lib/api.ts types against (sendValidated throws
 *  outside production on any mismatch).
 * ------------------------------------------------------------------ */

const h = vi.hoisted(() => ({
  getPublicIndustries: vi.fn(),
  suggestIndustry: vi.fn(),
  publishToAdmins: vi.fn(),
}));

vi.mock("../middleware/auth.js", () => ({
  requireAuth: (req: any, _res: any, next: any) => {
    req.user = { sub: "user_1", email: "user@test.com" };
    next();
  },
}));
vi.mock("../services/settings.js", () => ({
  getPublicIndustries: h.getPublicIndustries,
  suggestIndustry: h.suggestIndustry,
}));
vi.mock("../services/events.js", () => ({ publishToAdmins: h.publishToAdmins }));

const { default: router } = await import("./industries.routes.js");
const { errorHandler } = await import("../middleware/error.js");

let server: Server;
let base: string;
const app = express();
app.use(express.json());
app.use("/api/industries", router);
app.use(errorHandler);
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
});

describe("GET /api/industries", () => {
  it("returns the public industry list matching the shared contract", async () => {
    h.getPublicIndustries.mockReturnValue(["Plumbing", "Electrical"]);
    const res = await fetch(`${base}/api/industries`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ industries: ["Plumbing", "Electrical"] });
  });
});

describe("POST /api/industries/suggest", () => {
  it("submits a new proposal and notifies admins", async () => {
    h.suggestIndustry.mockResolvedValue("submitted");
    const res = await fetch(`${base}/api/industries/suggest`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ value: "Falconry" }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "submitted", value: "Falconry" });
    expect(h.publishToAdmins).toHaveBeenCalledWith({ type: "industry.suggested" });
  });

  it("400s an invalid value without calling suggestIndustry", async () => {
    const res = await fetch(`${base}/api/industries/suggest`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ value: "!!" }),
    });
    expect(res.status).toBe(400);
    expect(h.suggestIndustry).not.toHaveBeenCalled();
  });
});
