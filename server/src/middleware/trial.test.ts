import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Request, Response, NextFunction } from "express";

vi.mock("../services/trial.js", async () => {
  const actual = await vi.importActual<typeof import("../services/trial.js")>("../services/trial.js");
  return {
    ...actual,
    getEntitlement: vi.fn(),
    // Mocked too, or this suite silently needs a live database: validateTrial
    // calls it before deciding, it does a real Prisma read (and a Stripe
    // round-trip), and when that throws the middleware takes its catch branch —
    // so the 403 assertions failed for a reason that had nothing to do with the
    // logic under test. What this file tests is the decision, not the reconcile.
    reconcileSubscription: vi.fn(async () => undefined),
  };
});

import { getEntitlement } from "../services/trial.js";
import { validateTrial } from "./trial.js";

const getState = getEntitlement as unknown as ReturnType<typeof vi.fn>;

function mockRes() {
  const res = {} as Response & { statusCode?: number; body?: unknown };
  res.status = vi.fn((code: number) => {
    res.statusCode = code;
    return res;
  }) as unknown as Response["status"];
  res.json = vi.fn((body: unknown) => {
    res.body = body;
    return res;
  }) as unknown as Response["json"];
  return res;
}

const req = { user: { sub: "u1", email: "a@b.c", role: "USER" } } as unknown as Request;

beforeEach(() => vi.clearAllMocks());

describe("validateTrial middleware", () => {
  it("calls next() when not blocked", async () => {
    getState.mockResolvedValue({ blocked: false, status: "active", phase: "trial" });
    const next = vi.fn() as NextFunction;
    const res = mockRes();
    await validateTrial(req, res, next);
    expect(next).toHaveBeenCalledOnce();
    expect(res.status).not.toHaveBeenCalled();
  });

  it("blocks expired trial minutes with the right code", async () => {
    getState.mockResolvedValue({ blocked: true, status: "expired_minutes", phase: "trial" });
    const res = mockRes();
    await validateTrial(req, res, vi.fn());
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith({
      success: false,
      code: "TRIAL_EXPIRED_MINUTES",
      message: "Your free trial has ended because all trial minutes have been used.",
    });
  });

  it("blocks exhausted plan minutes with PLAN_MINUTES_EXHAUSTED", async () => {
    getState.mockResolvedValue({ blocked: true, status: "expired_minutes", phase: "active" });
    const res = mockRes();
    await validateTrial(req, res, vi.fn());
    expect(res.status).toHaveBeenCalledWith(403);
    expect((res.json as ReturnType<typeof vi.fn>).mock.calls[0][0].code).toBe(
      "PLAN_MINUTES_EXHAUSTED",
    );
  });
});
