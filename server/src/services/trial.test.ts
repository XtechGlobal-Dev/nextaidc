import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../prisma.js", () => ({
  prisma: {
    profile: {
      findUnique: vi.fn(),
      update: vi.fn(),
    },
  },
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

import { prisma } from "../prisma.js";
/** The stand-in above, typed as what it is: mocks by model and method. */
const fake = prisma as unknown as Record<string, Record<string, ReturnType<typeof vi.fn>>>;
import {
  evaluateTrialStatus,
  daysRemaining,
  minutesRemaining,
  getEntitlement,
  recordUsage,
  buildTrialStartData,
  applyActivePlanMinutes,
  entitlementError,
  clampCallSeconds,
  remainingCallSeconds,
  computeProration,
  VAPI_MIN_CALL_SECONDS,
  VAPI_MAX_CALL_SECONDS,
  TRIAL_STATUS,
} from "./trial.js";

const findUnique = fake.profile.findUnique as unknown as ReturnType<typeof vi.fn>;
const update = fake.profile.update as unknown as ReturnType<typeof vi.fn>;

const NOW = new Date("2026-06-22T00:00:00.000Z");
const inDays = (n: number) => new Date(NOW.getTime() + n * 24 * 60 * 60 * 1000);

const trialRow = (over: Record<string, unknown> = {}) => ({
  subscriptionStatus: "trialing",
  // The signup-time policy snapshot. false = signed up under the card-less rule,
  // which is every pre-existing account and the platform default.
  cardRequiredAtSignup: false,
  // When the first card was confirmed; null = never. Only consulted when
  // cardRequiredAtSignup is true.
  cardConfirmedAt: null,
  trialEndsAt: inDays(5),
  trialMinutesAllocated: 10,
  trialSecondsUsed: 0,
  planMinutesAllocated: null,
  planSecondsUsed: 0,
  currentPeriodEnd: null,
  subscriptionPlan: null,
  ...over,
});

const activeRow = (over: Record<string, unknown> = {}) => ({
  subscriptionStatus: "active",
  trialEndsAt: null,
  trialMinutesAllocated: null,
  trialSecondsUsed: 0,
  planMinutesAllocated: 200,
  planSecondsUsed: 0,
  currentPeriodEnd: inDays(30),
  subscriptionPlan: { includedMinutes: 200 },
  ...over,
});

beforeEach(() => vi.clearAllMocks());

describe("evaluateTrialStatus — spec edge cases", () => {
  it("Case 1: 10/10 used, 5 days left → EXPIRED_BY_MINUTES", () => {
    expect(
      evaluateTrialStatus({ minutesUsed: 10, minutesAllocated: 10, endsAt: inDays(5), now: NOW }),
    ).toBe(TRIAL_STATUS.EXPIRED_BY_MINUTES);
  });
  it("Case 2: 2/10 used, 0 days left → EXPIRED_BY_DATE", () => {
    expect(
      evaluateTrialStatus({ minutesUsed: 2, minutesAllocated: 10, endsAt: NOW, now: NOW }),
    ).toBe(TRIAL_STATUS.EXPIRED_BY_DATE);
  });
  it("Case 3: 0/10 used, 14 days left → ACTIVE", () => {
    expect(
      evaluateTrialStatus({ minutesUsed: 0, minutesAllocated: 10, endsAt: inDays(14), now: NOW }),
    ).toBe(TRIAL_STATUS.ACTIVE);
  });
  it("Case 4: 9.9/10 used, 1 day left → ACTIVE", () => {
    expect(
      evaluateTrialStatus({ minutesUsed: 9.9, minutesAllocated: 10, endsAt: inDays(1), now: NOW }),
    ).toBe(TRIAL_STATUS.ACTIVE);
  });
  it("Case 5: 10/10 used, 0 days left → EXPIRED_BY_MINUTES (precedence)", () => {
    expect(
      evaluateTrialStatus({ minutesUsed: 10, minutesAllocated: 10, endsAt: NOW, now: NOW }),
    ).toBe(TRIAL_STATUS.EXPIRED_BY_MINUTES);
  });
});

describe("daysRemaining / minutesRemaining", () => {
  it("rounds days up and floors at 0", () => {
    expect(daysRemaining(new Date(NOW.getTime() + 1.5 * 86400000), NOW)).toBe(2);
    expect(daysRemaining(NOW, NOW)).toBe(0);
    expect(daysRemaining(null, NOW)).toBe(0);
  });
  it("computes remaining minutes without going negative", () => {
    expect(minutesRemaining(3, 10)).toBe(7);
    expect(minutesRemaining(12, 10)).toBe(0);
  });
});

describe("getEntitlement — trial phase", () => {
  it("active trial reports minutes + days and not blocked", async () => {
    findUnique.mockResolvedValue(trialRow({ trialSecondsUsed: 180 }));
    const s = await getEntitlement("u1", NOW);
    expect(s.phase).toBe("trial");
    expect(s.isTrial).toBe(true);
    expect(s.minutesUsed).toBe(3);
    expect(s.minutesRemaining).toBe(7);
    expect(s.daysRemaining).toBe(5);
    expect(s.blocked).toBe(false);
  });
  it("blocks when trial minutes exhausted", async () => {
    findUnique.mockResolvedValue(trialRow({ trialSecondsUsed: 600 }));
    const s = await getEntitlement("u1", NOW);
    expect(s.status).toBe("expired_minutes");
    expect(s.blocked).toBe(true);
  });
  it("blocks when trial date passed", async () => {
    findUnique.mockResolvedValue(trialRow({ trialEndsAt: inDays(-1), trialSecondsUsed: 60 }));
    const s = await getEntitlement("u1", NOW);
    expect(s.status).toBe("expired_date");
    expect(s.blocked).toBe(true);
  });
});

describe("getEntitlement — active plan", () => {
  it("reports plan minutes and renewal days", async () => {
    findUnique.mockResolvedValue(activeRow({ planSecondsUsed: 60 * 60 })); // 60 min
    const s = await getEntitlement("u1", NOW);
    expect(s.phase).toBe("active");
    expect(s.minutesAllocated).toBe(200);
    expect(s.minutesUsed).toBe(60);
    expect(s.minutesRemaining).toBe(140);
    expect(s.daysRemaining).toBe(30);
    expect(s.blocked).toBe(false);
  });
  it("blocks when plan minutes exhausted", async () => {
    findUnique.mockResolvedValue(activeRow({ planSecondsUsed: 200 * 60 }));
    const s = await getEntitlement("u1", NOW);
    expect(s.status).toBe("expired_minutes");
    expect(s.blocked).toBe(true);
  });
  it("expires by date when the period ended with auto-renew off, even with minutes left", async () => {
    findUnique.mockResolvedValue(
      activeRow({ planSecondsUsed: 60, currentPeriodEnd: inDays(-1), autoRenew: false }),
    );
    const s = await getEntitlement("u1", NOW);
    expect(s.status).toBe("expired_date");
    expect(s.blocked).toBe(true);
    expect(s.minutesRemaining).toBe(199); // minutes remained, but the paid month is over
  });
  it("does NOT expire by date while auto-renew is on (period-end is a renewal, not a lapse)", async () => {
    findUnique.mockResolvedValue(
      activeRow({ planSecondsUsed: 60, currentPeriodEnd: inDays(-1), autoRenew: true }),
    );
    const s = await getEntitlement("u1", NOW);
    expect(s.status).toBe("active");
    expect(s.blocked).toBe(false);
  });
  it("treats 0 allocated minutes as unlimited", async () => {
    findUnique.mockResolvedValue(
      activeRow({ planMinutesAllocated: 0, planSecondsUsed: 99999, subscriptionPlan: { includedMinutes: 0 } }),
    );
    const s = await getEntitlement("u1", NOW);
    expect(s.unlimited).toBe(true);
    expect(s.blocked).toBe(false);
  });
});

describe("getEntitlement — unentitled", () => {
  it("none → card-less free trial, active", async () => {
    findUnique.mockResolvedValue(trialRow({ subscriptionStatus: "none", trialSecondsUsed: 0 }));
    const s = await getEntitlement("u1", NOW);
    expect(s.phase).toBe("trial");
    expect(s.isTrial).toBe(true);
    expect(s.minutesAllocated).toBe(10);
    expect(s.blocked).toBe(false);
  });
  it("none → blocked once the free-trial minutes are used up", async () => {
    // 10 min allowance, 11 min used → expired by minutes.
    findUnique.mockResolvedValue(trialRow({ subscriptionStatus: "none", trialSecondsUsed: 660 }));
    const s = await getEntitlement("u1", NOW);
    expect(s.status).toBe(TRIAL_STATUS.EXPIRED_BY_MINUTES);
    expect(s.blocked).toBe(true);
  });
  it("past_due → blocked", async () => {
    findUnique.mockResolvedValue(activeRow({ subscriptionStatus: "past_due" }));
    const s = await getEntitlement("u1", NOW);
    expect(s.status).toBe("past_due");
    expect(s.blocked).toBe(true);
  });
});

// The card wall is decided by cardRequiredAtSignup + cardConfirmedAt — never by status (Stripe
// writes "trialing" before any card) and never by the live toggle (an admin flip can't wall live customers).
describe("getEntitlement — the card-required wall", () => {
  it("blocks a card-required account that never confirmed a card", async () => {
    findUnique.mockResolvedValue(
      trialRow({ subscriptionStatus: "none", cardRequiredAtSignup: true, cardConfirmedAt: null }),
    );
    const s = await getEntitlement("u1", NOW);
    expect(s.blocked).toBe(true);
    expect(s.status).toBe("no_subscription");
    expect(s.phase).toBe("none");
    expect(s.canRenew).toBe(false);
    expect(s.planName).toBeNull();
  });

  it("reports NO_SUBSCRIPTION so the client shows the pick-a-plan copy", async () => {
    findUnique.mockResolvedValue(
      trialRow({ subscriptionStatus: "none", cardRequiredAtSignup: true, cardConfirmedAt: null }),
    );
    const s = await getEntitlement("u1", NOW);
    expect(entitlementError(s).code).toBe("NO_SUBSCRIPTION");
  });

  // The bypass: /subscribe creates a "trialing" Stripe sub BEFORE any card, so a
  // status-keyed wall would hand a free trial to anyone who picks a plan and closes the tab.
  it.each(["trialing", "active", "past_due", "canceled"])(
    "stays blocked even when Stripe moves the status to %s with no card confirmed",
    async (status) => {
      findUnique.mockResolvedValue(
        trialRow({ subscriptionStatus: status, cardRequiredAtSignup: true, cardConfirmedAt: null }),
      );
      const s = await getEntitlement("u1", NOW);
      expect(s.blocked).toBe(true);
      expect(s.status).toBe("no_subscription");
    },
  );

  it("GRANDFATHERING: a card-less account stays unblocked, whatever the admin toggle says", async () => {
    // Tripwire: the prisma mock has no `platformSetting`, so a live-setting lookup would throw.
    findUnique.mockResolvedValue(
      trialRow({ subscriptionStatus: "none", cardRequiredAtSignup: false, trialSecondsUsed: 0 }),
    );
    const s = await getEntitlement("u1", NOW);
    expect(s.blocked).toBe(false);
    expect(s.phase).toBe("trial");
  });

  it("treats a pre-migration row (both fields absent) as card-less, never walled", async () => {
    const row = trialRow({ subscriptionStatus: "none", trialSecondsUsed: 0 }) as Record<
      string,
      unknown
    >;
    delete row.cardRequiredAtSignup;
    delete row.cardConfirmedAt;
    findUnique.mockResolvedValue(row);
    const s = await getEntitlement("u1", NOW);
    expect(s.blocked).toBe(false);
    expect(s.phase).toBe("trial");
  });

  it("stops walling once the card is confirmed", async () => {
    findUnique.mockResolvedValue(
      trialRow({
        subscriptionStatus: "trialing",
        cardRequiredAtSignup: true,
        cardConfirmedAt: NOW,
      }),
    );
    const s = await getEntitlement("u1", NOW);
    expect(s.phase).toBe("trial");
    expect(s.blocked).toBe(false);
  });

  it("never walls an ADMIN", async () => {
    findUnique.mockResolvedValue(
      trialRow({
        subscriptionStatus: "none",
        cardRequiredAtSignup: true,
        cardConfirmedAt: null,
        user: { role: "ADMIN" },
      }),
    );
    const s = await getEntitlement("u1", NOW);
    expect(s.blocked).toBe(false);
    expect(s.unlimited).toBe(true);
  });

  // A column in the TS type but missing from the prisma select reads undefined (the
  // result is cast), and the wall silently never engages.
  it.each(["cardRequiredAtSignup", "cardConfirmedAt"])(
    "asks Prisma for %s (or the wall silently no-ops)",
    async (column) => {
      findUnique.mockResolvedValue(trialRow({ subscriptionStatus: "none" }));
      await getEntitlement("u1", NOW);
      expect(findUnique.mock.calls[0][0].select[column]).toBe(true);
    },
  );
});

describe("recordUsage", () => {
  it("increments trial seconds atomically and recomputes status", async () => {
    findUnique
      .mockResolvedValueOnce({ subscriptionStatus: "trialing" }) // recordUsage guard
      .mockResolvedValueOnce(trialRow({ trialSecondsUsed: 600 })); // getEntitlement after
    update
      .mockResolvedValueOnce({
        trialEndsAt: inDays(5),
        trialMinutesAllocated: 10,
        trialSecondsUsed: 600,
      })
      .mockResolvedValue({});

    const s = await recordUsage("u1", 300, NOW);
    expect(update).toHaveBeenNthCalledWith(1, {
      where: { userId: "u1" },
      data: { trialSecondsUsed: { increment: 300 } },
      select: expect.any(Object),
    });
    expect(update).toHaveBeenNthCalledWith(2, {
      where: { userId: "u1" },
      data: { trialStatus: TRIAL_STATUS.EXPIRED_BY_MINUTES },
    });
    expect(s?.status).toBe("expired_minutes");
  });

  it("increments plan seconds for active users", async () => {
    findUnique
      .mockResolvedValueOnce({ subscriptionStatus: "active" })
      .mockResolvedValueOnce(activeRow({ planSecondsUsed: 120 }));
    update.mockResolvedValue({});

    await recordUsage("u1", 120, NOW);
    expect(update).toHaveBeenCalledWith({
      where: { userId: "u1" },
      data: { planSecondsUsed: { increment: 120 } },
    });
  });

  it("no-ops for zero / negative seconds", async () => {
    expect(await recordUsage("u1", 0, NOW)).toBeNull();
    expect(await recordUsage("u1", -5, NOW)).toBeNull();
  });

  it("accrues card-less free-trial usage for 'none' accounts", async () => {
    findUnique
      .mockResolvedValueOnce({ subscriptionStatus: "none" }) // recordUsage guard
      .mockResolvedValueOnce(trialRow({ subscriptionStatus: "none", trialSecondsUsed: 120 })); // getEntitlement after
    update.mockResolvedValue({});

    const s = await recordUsage("u1", 120, NOW);
    expect(update).toHaveBeenCalledWith({
      where: { userId: "u1" },
      data: { trialSecondsUsed: { increment: 120 } },
    });
    expect(s?.phase).toBe("trial");
    expect(s?.isTrial).toBe(true);
  });
});

describe("buildTrialStartData", () => {
  it("snapshots the configured trial minutes", async () => {
    const d = await buildTrialStartData(NOW);
    expect(d.trialMinutesAllocated).toBe(10);
    expect(d.trialSecondsUsed).toBe(0);
    expect(d.trialStatus).toBe(TRIAL_STATUS.ACTIVE);
    expect(d.trialStartedAt).toBe(NOW);
  });
});

describe("applyActivePlanMinutes", () => {
  it("snapshots minutes and resets usage on a first activation", async () => {
    // The reset comes from `resetUsage`, not a null stored end — that also happens when
    // a webhook hasn't landed, and treating it as a new cycle wiped live usage.
    findUnique.mockResolvedValue({ currentPeriodEnd: null });
    update.mockResolvedValue({});
    await applyActivePlanMinutes("u1", {
      includedMinutes: 200,
      periodEnd: inDays(30),
      resetUsage: true,
    });
    expect(update).toHaveBeenCalledWith({
      where: { userId: "u1" },
      data: {
        planMinutesAllocated: 200,
        currentPeriodEnd: inDays(30),
        planSecondsUsed: 0,
        usageAlertsSent: "",
        graceStartedAt: null,
        graceEndsAt: null,
        graceNotifyStage: null,
      },
    });
  });

  it("does not reset usage when the period is unchanged", async () => {
    findUnique.mockResolvedValue({ currentPeriodEnd: inDays(30) });
    update.mockResolvedValue({});
    await applyActivePlanMinutes("u1", { includedMinutes: 200, periodEnd: inDays(30) });
    const arg = update.mock.calls[0][0];
    expect(arg.data.planSecondsUsed).toBeUndefined();
  });

  it("does NOT re-credit minutes just because the allowance is spent", async () => {
    // Exhaustion isn't a billing boundary: inferring a reset from "usage >= allowance" fired on
    // the subscription.updated webhook, which also fires for no-money edits — free minutes.
    findUnique.mockResolvedValue({
      currentPeriodEnd: inDays(30),
      planMinutesAllocated: 200,
      planSecondsUsed: 200 * 60, // every minute spent
    });
    update.mockResolvedValue({});
    await applyActivePlanMinutes("u1", { includedMinutes: 200, periodEnd: inDays(30) });
    const arg = update.mock.calls[0][0];
    expect(arg.data.planSecondsUsed, "usage must survive a non-cycle event").toBeUndefined();
    expect(arg.data.usageAlertsSent).toBeUndefined();
  });

  it("still resets an exhausted cycle when the caller confirms a charge", async () => {
    // The paid paths (renewal, conversion, upgrade) all pass resetUsage: true.
    findUnique.mockResolvedValue({
      currentPeriodEnd: inDays(30),
      planMinutesAllocated: 200,
      planSecondsUsed: 200 * 60,
    });
    update.mockResolvedValue({});
    await applyActivePlanMinutes("u1", {
      includedMinutes: 200,
      periodEnd: inDays(30),
      resetUsage: true,
    });
    expect(update.mock.calls[0][0].data.planSecondsUsed).toBe(0);
  });

  it("still resets when the billing period genuinely advances", async () => {
    findUnique.mockResolvedValue({
      currentPeriodEnd: inDays(30),
      planMinutesAllocated: 200,
      planSecondsUsed: 200 * 60,
    });
    update.mockResolvedValue({});
    await applyActivePlanMinutes("u1", { includedMinutes: 200, periodEnd: inDays(60) });
    expect(update.mock.calls[0][0].data.planSecondsUsed).toBe(0);
  });

  it("resets usage on an upgrade even when the period is unchanged", async () => {
    // Mid-cycle upgrade keeps the same currentPeriodEnd but must grant a fresh
    // allowance — minutes used on the old plan must not carry into the new one.
    findUnique.mockResolvedValue({ currentPeriodEnd: inDays(30) });
    update.mockResolvedValue({});
    await applyActivePlanMinutes("u1", {
      includedMinutes: 200,
      periodEnd: inDays(30),
      resetUsage: true,
    });
    const arg = update.mock.calls[0][0];
    expect(arg.data.planSecondsUsed).toBe(0);
    expect(arg.data.usageAlertsSent).toBe("");
    expect(arg.data.planMinutesAllocated).toBe(200);
  });
});

describe("clampCallSeconds", () => {
  it("clamps into Vapi's [10, 43200] range and floors", () => {
    expect(clampCallSeconds(0)).toBe(VAPI_MIN_CALL_SECONDS);
    expect(clampCallSeconds(5)).toBe(VAPI_MIN_CALL_SECONDS);
    expect(clampCallSeconds(462.9)).toBe(462);
    expect(clampCallSeconds(99999)).toBe(VAPI_MAX_CALL_SECONDS);
  });
});

describe("remainingCallSeconds — per-call duration cap", () => {
  const base = {
    phase: "trial",
    status: "active",
    isTrial: true,
    minutesAllocated: 10,
    minutesUsed: 0,
    daysRemaining: 5,
    trialEndsAt: null,
    periodEnd: null,
  } as const;

  it("caps to the seconds left (the 2/10 → 8 min scenario)", () => {
    // 8 minutes remaining → 480s cap, so a call can't push usage past 10.
    expect(
      remainingCallSeconds({ ...base, unlimited: false, blocked: false, minutesRemaining: 8 } as never),
    ).toBe(480);
  });

  it("returns null (uncapped) for unlimited plans", () => {
    expect(
      remainingCallSeconds({ ...base, unlimited: true, blocked: false, minutesRemaining: 0 } as never),
    ).toBeNull();
  });

  it("gives the minimum so a blocked user's call is cut almost immediately", () => {
    expect(
      remainingCallSeconds({ ...base, unlimited: false, blocked: true, minutesRemaining: 0 } as never),
    ).toBe(VAPI_MIN_CALL_SECONDS);
  });

  it("never returns below the Vapi minimum for tiny remainders", () => {
    expect(
      remainingCallSeconds({ ...base, unlimited: false, blocked: false, minutesRemaining: 0.05 } as never),
    ).toBe(VAPI_MIN_CALL_SECONDS);
  });
});

describe("computeProration — minutes-based credit", () => {
  it("the spec example: 150/300 left on a $30 plan → $15 credit", () => {
    // Upgrade to a $50 plan: credit 15, pay 50 - 15 = 35.
    const r = computeProration({
      currentPriceCents: 3000,
      newPriceCents: 5000,
      minutesAllocated: 300,
      minutesRemaining: 150,
    });
    expect(r.direction).toBe("upgrade");
    expect(r.creditCents).toBe(1500);
    expect(r.amountDueCents).toBe(3500);
  });

  it("downgrade charges nothing now", () => {
    const r = computeProration({
      currentPriceCents: 5000,
      newPriceCents: 3000,
      minutesAllocated: 300,
      minutesRemaining: 150,
    });
    expect(r.direction).toBe("downgrade");
    expect(r.amountDueCents).toBe(0);
  });

  it("credit never exceeds the new price (amount due floored at 0)", () => {
    const r = computeProration({
      currentPriceCents: 10000,
      newPriceCents: 4000,
      minutesAllocated: 100,
      minutesRemaining: 100, // full credit 10000 > 4000
    });
    // direction is downgrade here (cheaper), so due = 0 anyway
    expect(r.amountDueCents).toBe(0);
  });

  it("full upgrade with no usage → pay full difference (credit = full current price)", () => {
    const r = computeProration({
      currentPriceCents: 3000,
      newPriceCents: 5000,
      minutesAllocated: 300,
      minutesRemaining: 300,
    });
    expect(r.creditCents).toBe(3000);
    expect(r.amountDueCents).toBe(2000);
  });

  // Credit is a share of money that actually changed hands. Basing it on list price
  // refunded a 50%-off customer more than they paid.
  describe("with a discount, the credit follows what was PAID", () => {
    const halfPriceUntouched = (paidCents?: number) =>
      computeProration({
        currentPriceCents: 2000,
        newPriceCents: 5000,
        minutesAllocated: 300,
        minutesRemaining: 300, // nothing used
        ...(paidCents === undefined ? {} : { paidCents }),
      });

    it("credits the $10 paid, not the $20 list price → $40 due, not $30", () => {
      const r = halfPriceUntouched(1000);
      expect(r.creditCents).toBe(1000);
      expect(r.amountDueCents).toBe(4000);
    });

    it("credits nothing on a 100%-off coupon — no money changed hands", () => {
      const r = halfPriceUntouched(0);
      expect(r.creditCents).toBe(0);
      expect(r.amountDueCents).toBe(5000);
    });

    it("prorates the paid amount by usage, same as before", () => {
      const r = computeProration({
        currentPriceCents: 2000,
        newPriceCents: 5000,
        minutesAllocated: 300,
        minutesRemaining: 150, // half used
        paidCents: 1000,
      });
      expect(r.creditCents).toBe(500);
      expect(r.amountDueCents).toBe(4500);
    });

    it("counts an earlier upgrade delta, so a second upgrade isn't under-credited", () => {
      // $10 discounted charge + a $40 delta already paid on the way to this plan.
      const r = computeProration({
        currentPriceCents: 5000,
        newPriceCents: 8000,
        minutesAllocated: 300,
        minutesRemaining: 300,
        paidCents: 5000,
      });
      expect(r.creditCents).toBe(5000);
      expect(r.amountDueCents).toBe(3000);
    });

    it("never credits more than the plan is worth, whatever was paid", () => {
      const r = computeProration({
        currentPriceCents: 2000,
        newPriceCents: 5000,
        minutesAllocated: 300,
        minutesRemaining: 300,
        paidCents: 9999, // nonsense input must not become a windfall
      });
      expect(r.creditCents).toBe(2000);
    });

    it("falls back to the list price when the paid amount is unknown", () => {
      // Free trial, or Stripe unreachable — undiscounted behaviour, unchanged.
      const r = halfPriceUntouched(undefined);
      expect(r.creditCents).toBe(2000);
      expect(r.amountDueCents).toBe(3000);
    });

    it("still calls a cheaper plan a downgrade, discount or not", () => {
      // Paid $25 for a $50 plan; $30 is a DOWNGRADE even though 30 > 25.
      const r = computeProration({
        currentPriceCents: 5000,
        newPriceCents: 3000,
        minutesAllocated: 300,
        minutesRemaining: 300,
        paidCents: 2500,
      });
      expect(r.direction).toBe("downgrade");
      expect(r.amountDueCents).toBe(0);
    });
  });

  it("unlimited current plan (allocated 0) → no credit", () => {
    const r = computeProration({
      currentPriceCents: 3000,
      newPriceCents: 5000,
      minutesAllocated: 0,
      minutesRemaining: 0,
    });
    expect(r.creditCents).toBe(0);
    expect(r.amountDueCents).toBe(5000);
  });
});

describe("entitlementError", () => {
  it("uses a distinct code for plan exhaustion vs trial", () => {
    expect(
      entitlementError({ phase: "active", status: "expired_minutes" } as never).code,
    ).toBe("PLAN_MINUTES_EXHAUSTED");
    expect(
      entitlementError({ phase: "trial", status: "expired_minutes" } as never).code,
    ).toBe("TRIAL_EXPIRED_MINUTES");
    expect(entitlementError({ phase: "none", status: "no_subscription" } as never).code).toBe(
      "NO_SUBSCRIPTION",
    );
  });
});
