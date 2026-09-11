import { describe, it, expect, vi } from "vitest";

// grace.ts pulls in trial.ts (for daysRemaining), which transitively imports
// prisma + billing. Stub those so the import graph never touches a real DB.
vi.mock("../prisma.js", () => ({ prisma: { profile: { findUnique: vi.fn(), update: vi.fn() } } }));
vi.mock("./billing.js", () => ({
  getTrialDays: vi.fn(async () => 14),
  getTrialMinutes: vi.fn(async () => 10),
}));

import { decideGraceAction, stageRank, GRACE_REMINDER_DAYS_BEFORE, type GraceDecisionInput } from "./grace.js";

const NOW = new Date("2026-06-22T00:00:00.000Z");
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const inDays = (n: number) => new Date(NOW.getTime() + n * DAY);
const inHours = (n: number) => new Date(NOW.getTime() + n * HOUR);

/** A blocked, lapsed-trial customer holding a number, not yet in grace. */
const base = (over: Partial<GraceDecisionInput> = {}): GraceDecisionInput => ({
  enabled: true,
  days: 7,
  blocked: true,
  isTrial: true,
  planLapsed: false,
  hasNumber: true,
  graceStartedAt: null,
  graceEndsAt: null,
  graceNotifyStage: null,
  now: NOW,
  ...over,
});

describe("stageRank", () => {
  it("orders the email stages monotonically", () => {
    expect(stageRank(null)).toBe(0);
    expect(stageRank("granted")).toBe(1);
    expect(stageRank("reminder")).toBe(2);
    expect(stageRank("final")).toBe(3);
    expect(stageRank("bogus")).toBe(0);
  });
});

describe("decideGraceAction — granting", () => {
  it("opens a grace window for a lapsed trial with a number", () => {
    expect(decideGraceAction(base())).toEqual({ type: "start", graceEndsAt: inDays(7) });
  });

  it("honours a custom grace length", () => {
    expect(decideGraceAction(base({ days: 3 }))).toEqual({ type: "start", graceEndsAt: inDays(3) });
  });

  it("does nothing when the feature is disabled", () => {
    expect(decideGraceAction(base({ enabled: false }))).toEqual({ type: "noop" });
  });

  it("skips a blocked PAID plan that hasn't lapsed yet (still mid-period)", () => {
    expect(decideGraceAction(base({ isTrial: false, planLapsed: false }))).toEqual({ type: "noop" });
  });

  it("opens a grace window for a lapsed PAID plan with a number", () => {
    expect(decideGraceAction(base({ isTrial: false, planLapsed: true }))).toEqual({
      type: "start",
      graceEndsAt: inDays(7),
    });
  });

  it("skips a lapsed plan that holds no number", () => {
    expect(decideGraceAction(base({ hasNumber: false }))).toEqual({ type: "noop" });
    expect(decideGraceAction(base({ isTrial: false, planLapsed: true, hasNumber: false }))).toEqual({
      type: "noop",
    });
  });
});

describe("decideGraceAction — recharged / unblocked", () => {
  it("clears stale grace state once the user is no longer blocked", () => {
    expect(
      decideGraceAction(base({ blocked: false, graceStartedAt: inDays(-1), graceEndsAt: inDays(6) })),
    ).toEqual({ type: "clear" });
  });

  it("no-ops an unblocked user that never had grace", () => {
    expect(decideGraceAction(base({ blocked: false }))).toEqual({ type: "noop" });
  });
});

describe("decideGraceAction — inside the window", () => {
  const inGrace = (endsAt: Date, stage: string | null) =>
    base({ graceStartedAt: inDays(-1), graceEndsAt: endsAt, graceNotifyStage: stage });

  it("releases once the window has lapsed", () => {
    expect(decideGraceAction(inGrace(inHours(-1), "final"))).toEqual({ type: "release" });
  });

  it("releases exactly at the deadline", () => {
    expect(decideGraceAction(inGrace(NOW, "final"))).toEqual({ type: "release" });
  });

  it("stays quiet while comfortably mid-window", () => {
    expect(decideGraceAction(inGrace(inDays(5), "granted"))).toEqual({ type: "noop" });
  });

  it(`sends the reminder once ${GRACE_REMINDER_DAYS_BEFORE} days remain`, () => {
    expect(decideGraceAction(inGrace(inDays(2), "granted"))).toEqual({ type: "reminder" });
  });

  it("does not resend the reminder", () => {
    expect(decideGraceAction(inGrace(inDays(2), "reminder"))).toEqual({ type: "noop" });
  });

  it("sends the final warning inside the last 24h", () => {
    expect(decideGraceAction(inGrace(inHours(12), "granted"))).toEqual({ type: "final" });
  });

  it("sends final at the 24h boundary", () => {
    expect(decideGraceAction(inGrace(inHours(24), "granted"))).toEqual({ type: "final" });
  });

  it("escalates straight to final even if the reminder was the last email", () => {
    expect(decideGraceAction(inGrace(inHours(6), "reminder"))).toEqual({ type: "final" });
  });

  it("does not resend the final warning", () => {
    expect(decideGraceAction(inGrace(inHours(6), "final"))).toEqual({ type: "noop" });
  });

  it("clears an in-grace user the moment they pay", () => {
    const stillBlocked = inGrace(inDays(2), "granted");
    expect(decideGraceAction(stillBlocked)).toEqual({ type: "reminder" }); // sanity: blocked → reminder
    expect(decideGraceAction({ ...stillBlocked, blocked: false })).toEqual({ type: "clear" });
  });
});
