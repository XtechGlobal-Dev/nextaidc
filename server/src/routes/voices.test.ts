import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";
import express from "express";
import type { Server } from "node:http";

/* ------------------------------------------------------------------ *
 *  API contract pilot: this route's responses go through sendValidated()
 *  against the shared @shared/contracts/voices schemas — a passing
 *  assertion here confirms the live response matches what src/lib/api.ts
 *  types against on the frontend.
 * ------------------------------------------------------------------ */

const h = vi.hoisted(() => ({
  getVoiceCatalogFor: vi.fn(),
  getUserVoiceAccess: vi.fn(),
  resolveVoices: vi.fn(),
}));

vi.mock("../env.js", () => ({
  env: { JWT_SECRET: "test-secret-for-the-voices-suite-xxxxxxx" },
}));
vi.mock("../middleware/auth.js", () => ({
  requireAuth: (req: any, _res: any, next: any) => {
    // Platform account (no brandId): agent config lookup is skipped entirely.
    req.user = { sub: "user_1", brandId: null };
    next();
  },
}));
vi.mock("../services/tenantDb.js", () => ({ requestTenant: vi.fn() }));
vi.mock("../services/voices.js", () => ({
  getVoiceCatalogFor: h.getVoiceCatalogFor,
  getUserVoiceAccess: h.getUserVoiceAccess,
  resolveVoices: h.resolveVoices,
  DEFAULT_AGENT_VOICE_ID: "default-voice-id",
}));

const { default: router } = await import("./voices.routes.js");

let server: Server;
let base: string;
const app = express();
app.use(express.json());
app.use("/api/voices", router);
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

const SAMPLE_VOICE = {
  id: "theia",
  name: "Theia",
  descriptor: "Warm & Friendly",
  region: "Australian",
  previewUrl: null,
};

describe("GET /api/voices/all", () => {
  it("returns both providers' catalogs matching the shared contract", async () => {
    h.getVoiceCatalogFor.mockImplementation(async (provider: string) =>
      provider === "deepgram" ? [SAMPLE_VOICE] : [],
    );
    const res = await fetch(`${base}/api/voices/all`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ deepgram: [SAMPLE_VOICE], elevenlabs: [] });
  });
});

describe("GET /api/voices", () => {
  it("returns the user's entitled voices for a platform account (no brand)", async () => {
    h.getUserVoiceAccess.mockResolvedValue({
      canChange: true,
      voiceIds: ["theia"],
      isAdmin: true,
      categoryTitle: null,
      planName: null,
    });
    h.resolveVoices.mockImplementation(async (ids: string[]) =>
      ids.includes("theia") || ids.includes("default-voice-id")
        ? [{ ...SAMPLE_VOICE, id: ids[0], provider: "deepgram" }]
        : [],
    );

    const res = await fetch(`${base}/api/voices`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({
      voices: [{ ...SAMPLE_VOICE, id: "theia", provider: "deepgram", entitled: true, plans: [] }],
      current: { ...SAMPLE_VOICE, id: "default-voice-id", provider: "deepgram", entitled: true, plans: [] },
      locked: false,
      category: null,
      currentPlanName: null,
    });
  });
});
