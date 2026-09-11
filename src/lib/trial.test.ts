import { describe, it, expect } from "vitest";
import { daysBadge, minutesBadge, blockedCopy, isTrialExpired, trialBadges } from "@/lib/trial";
import type { TrialState } from "@/types";

const baseState: TrialState = {
  phase: "trial",
  status: "active",
  isTrial: true,
  unlimited: false,
  minutesAllocated: 10,
  minutesUsed: 3,
  minutesRemaining: 7,
  planMinutes: 10,
  daysRemaining: 14,
  trialDays: 14,
  trialEndsAt: null,
  periodEnd: null,
  blocked: false,
  canRenew: false,
  autoRenew: false,
  planName: "Free Trial",
  graceActive: false,
  graceEndsAt: null,
  graceDaysRemaining: 0,
  suspended: false,
  adminSuspended: false,
};

describe("daysBadge", () => {
  it("is green with >5 days", () => {
    expect(daysBadge(14, false)).toEqual({ text: "Valid for 14 days", tone: "green" });
    expect(daysBadge(6, false)).toEqual({ text: "Valid for 6 days", tone: "green" });
  });
  it("is orange at 5 days or fewer (but >1)", () => {
    expect(daysBadge(5, false)).toEqual({ text: "Valid for 5 days", tone: "orange" });
    expect(daysBadge(2, false)).toEqual({ text: "Valid for 2 days", tone: "orange" });
  });
  it("is red with exactly 1 day", () => {
    expect(daysBadge(1, false)).toEqual({ text: "Valid for 1 day", tone: "red" });
  });
  it("is red and 'Trial Expired' when expired or out of days", () => {
    expect(daysBadge(0, false)).toEqual({ text: "Trial Expired", tone: "red" });
    expect(daysBadge(9, true)).toEqual({ text: "Trial Expired", tone: "red" });
  });
});

describe("minutesBadge", () => {
  it("is green above 50% remaining", () => {
    expect(minutesBadge(7, 10)).toEqual({ text: "7 Minutes Left", tone: "green" });
  });
  it("is orange between 25% and 50% remaining", () => {
    expect(minutesBadge(5, 10).tone).toBe("orange");
    expect(minutesBadge(2.5, 10).tone).toBe("orange");
  });
  it("is red below 25% remaining", () => {
    expect(minutesBadge(2, 10).tone).toBe("red");
  });
  it("singularizes 1 minute", () => {
    expect(minutesBadge(1, 10).text).toBe("1 Minute Left");
  });
  it("shows 'Trial Minutes Exhausted' at zero", () => {
    expect(minutesBadge(0, 10)).toEqual({ text: "Trial Minutes Exhausted", tone: "red" });
  });
});

describe("blockedCopy", () => {
  it("maps trial minutes expiry", () => {
    expect(blockedCopy({ ...baseState, blocked: true, status: "expired_minutes" })).toEqual({
      title: "Trial Expired",
      reason: "All trial minutes used",
      cta: "Renew Required",
    });
  });
  it("maps trial date expiry", () => {
    expect(blockedCopy({ ...baseState, blocked: true, status: "expired_date" })).toEqual({
      title: "Trial Expired",
      reason: "Trial Period Ended",
      cta: "Renew Required",
    });
  });
  it("maps plan date expiry (active phase)", () => {
    const copy = blockedCopy({
      ...baseState,
      phase: "active",
      isTrial: false,
      blocked: true,
      status: "expired_date",
    });
    expect(copy?.title).toBe("Plan Expired");
    expect(copy?.cta).toBe("Renew Plan");
  });
  it("maps plan-minutes exhaustion (active phase)", () => {
    const copy = blockedCopy({
      ...baseState,
      phase: "active",
      isTrial: false,
      blocked: true,
      status: "expired_minutes",
    });
    expect(copy?.title).toBe("Plan Minutes Used Up");
  });
  it("maps past_due and no_subscription", () => {
    expect(blockedCopy({ ...baseState, blocked: true, status: "past_due" })?.title).toBe(
      "Payment Failed",
    );
    expect(
      blockedCopy({ ...baseState, phase: "none", blocked: true, status: "no_subscription" })?.title,
    ).toBe("No Active Plan");
  });
  it("returns null when not blocked", () => {
    expect(blockedCopy(baseState)).toBeNull();
    expect(isTrialExpired("active")).toBe(false);
    expect(isTrialExpired("expired_date")).toBe(true);
  });
});

describe("trialBadges", () => {
  it("derives both badges from a state", () => {
    const { days, minutes } = trialBadges(baseState);
    expect(days.tone).toBe("green");
    expect(minutes.text).toBe("7 Minutes Left");
  });
});
