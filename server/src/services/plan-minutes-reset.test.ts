import { describe, it, expect, vi, beforeEach } from "vitest";

// Usage must survive non-cycle billing events. Past bugs: a null stored currentPeriodEnd
// read as "new period" (auto-renew toggle wiped usage), and a spent allowance read as a boundary (free refill).

vi.mock("../prisma.js", () => ({
  prisma: { profile: { findUnique: vi.fn(), update: vi.fn() } },
}));
// The profile lives in the customer's brand's database — the same stand-in here —
// and the plan a test embeds on the row stands in for the catalogue join.
vi.mock("./tenantDb.js", async () => {
  const { prisma } = await import("../prisma.js");
  class TenantUnavailableError extends Error {}
  return { tenantForUser: async () => prisma, TenantUnavailableError };
});
vi.mock("./planLookup.js", () => ({ withPlan: async (p: unknown) => p, withPlans: async (p: unknown) => p }));
vi.mock("./billing.js", () => ({
  getTrialDays: vi.fn(async () => 14),
  getTrialMinutes: vi.fn(async () => 10),
}));
vi.mock("./settings.js", () => ({ integrationsStatus: vi.fn(() => ({ stripe: true })) }));
vi.mock("./stripe.js", () => ({
  endTrialNow: vi.fn(),
  getSubscription: vi.fn(),
  getSubscriptionAutoRenew: vi.fn(),
  getLatestPaidInvoice: vi.fn(async () => null),
  renewSubscriptionNow: vi.fn(),
}));
vi.mock("./email.js", () => ({ planActivatedEmail: vi.fn(), usageThresholdEmail: vi.fn() }));
vi.mock("./notifications.js", () => ({ notify: vi.fn() }));
vi.mock("./commission.js", () => ({ accrueCommissionForInvoice: vi.fn() }));

import { prisma } from "../prisma.js";
/** The stand-in above, typed as what it is: mocks by model and method. */
const fake = prisma as unknown as Record<string, Record<string, ReturnType<typeof vi.fn>>>;
import { applyActivePlanMinutes } from "./trial.js";

const findUnique = fake.profile.findUnique as unknown as ReturnType<typeof vi.fn>;
const update = fake.profile.update as unknown as ReturnType<typeof vi.fn>;

const PERIOD_END = new Date("2026-08-22T00:00:00.000Z");
/** 100 of 200 minutes used on a PREMIUM cycle. */
const used100of200 = (over: Record<string, unknown> = {}) => ({
  currentPeriodEnd: PERIOD_END,
  planSecondsUsed: 100 * 60,
  planMinutesAllocated: 200,
  ...over,
});
/** The data object written by the last profile.update. */
const written = () => update.mock.calls[0][0].data as Record<string, unknown>;

beforeEach(() => {
  vi.clearAllMocks();
  update.mockResolvedValue({});
});

describe("applyActivePlanMinutes — usage must survive non-cycle events", () => {
  it("keeps usage when nothing about the cycle changed (auto-renew toggle / downgrade scheduled)", async () => {
    findUnique.mockResolvedValue(used100of200());

    await applyActivePlanMinutes("u1", { includedMinutes: 200, periodEnd: PERIOD_END });

    expect(written()).not.toHaveProperty("planSecondsUsed");
    expect(written().planMinutesAllocated).toBe(200);
  });

  it("keeps usage when the stored period end is unknown — a null end proves no boundary", async () => {
    // The exact reported state: billing page shows "Renews —".
    findUnique.mockResolvedValue(used100of200({ currentPeriodEnd: null }));

    await applyActivePlanMinutes("u1", { includedMinutes: 200, periodEnd: PERIOD_END });

    expect(written()).not.toHaveProperty("planSecondsUsed");
  });

  it("keeps usage when the caller has no period end to offer", async () => {
    findUnique.mockResolvedValue(used100of200());

    await applyActivePlanMinutes("u1", { includedMinutes: 200, periodEnd: null });

    expect(written()).not.toHaveProperty("planSecondsUsed");
  });

  it("never blanks a known period end with null", async () => {
    findUnique.mockResolvedValue(used100of200());

    await applyActivePlanMinutes("u1", { includedMinutes: 200, periodEnd: null });

    expect(written()).not.toHaveProperty("currentPeriodEnd");
  });
});

describe("applyActivePlanMinutes — usage MUST reset on a real new cycle", () => {
  it("resets when the period end actually moves forward (renewal)", async () => {
    findUnique.mockResolvedValue(used100of200());
    const nextCycle = new Date(PERIOD_END.getTime() + 30 * 24 * 60 * 60 * 1000);

    await applyActivePlanMinutes("u1", { includedMinutes: 200, periodEnd: nextCycle });

    expect(written().planSecondsUsed).toBe(0);
    expect(written().currentPeriodEnd).toEqual(nextCycle);
  });

  it("resets when explicitly forced (upgrade, /renew charge, trial→paid)", async () => {
    findUnique.mockResolvedValue(used100of200());

    await applyActivePlanMinutes("u1", {
      includedMinutes: 200,
      periodEnd: PERIOD_END,
      resetUsage: true,
    });

    expect(written().planSecondsUsed).toBe(0);
  });

  it("resets on an early auto-renew, the way the renewal path actually calls it", async () => {
    // The renewal path claims (zeroes) the counter first, then calls here with
    // resetUsage set and overage explicit — it never inferred anything from exhaustion.
    findUnique.mockResolvedValue(used100of200({ planSecondsUsed: 0 }));

    await applyActivePlanMinutes("u1", {
      includedMinutes: 200,
      periodEnd: PERIOD_END,
      resetUsage: true,
    });

    expect(written().planSecondsUsed).toBe(0);
  });

  it("still carries overage into the new cycle", async () => {
    // 201 of 200 used → 1 min carried, arriving via carryOverSeconds because the
    // claim already zeroed the stored counter.
    findUnique.mockResolvedValue(used100of200({ planSecondsUsed: 0 }));

    await applyActivePlanMinutes("u1", {
      includedMinutes: 200,
      periodEnd: PERIOD_END,
      resetUsage: true,
      carryOverSeconds: 60,
    });

    expect(written().planSecondsUsed).toBe(60);
  });
});

describe("applyActivePlanMinutes — an exhausted allowance is not a paid cycle", () => {
  // Running out is a STATE, not a billing event. Treating it as a boundary gave a
  // free refill on any no-money subscription.updated ("minutes exhausted, minutes came back").

  it("does not re-credit a spent allowance on a non-cycle event", async () => {
    findUnique.mockResolvedValue(used100of200({ planSecondsUsed: 200 * 60 }));

    await applyActivePlanMinutes("u1", { includedMinutes: 200, periodEnd: PERIOD_END });

    expect(written()).not.toHaveProperty("planSecondsUsed");
    expect(written()).not.toHaveProperty("usageAlertsSent");
  });

  it("does not re-credit an OVER-spent allowance either", async () => {
    findUnique.mockResolvedValue(used100of200({ planSecondsUsed: 250 * 60 }));

    await applyActivePlanMinutes("u1", { includedMinutes: 200, periodEnd: PERIOD_END });

    expect(written()).not.toHaveProperty("planSecondsUsed");
  });

  it("keeps the block in place across repeated events", async () => {
    // The webhook fires many times over a cycle; none of them may top the user up.
    for (const _ of [1, 2, 3]) {
      vi.clearAllMocks();
      update.mockResolvedValue({});
      findUnique.mockResolvedValue(used100of200({ planSecondsUsed: 200 * 60 }));
      await applyActivePlanMinutes("u1", { includedMinutes: 200, periodEnd: PERIOD_END });
      expect(written()).not.toHaveProperty("planSecondsUsed");
    }
  });
});
