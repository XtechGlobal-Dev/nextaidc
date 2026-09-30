import { describe, it, expect, vi } from "vitest";

// A brand's AI pause ("hold"): billing outranks the AI cap, which outranks minutes; nobody lapses who
// owes nothing; never-paid locks the admin panel at once but only pauses the AI after the grace period.

vi.mock("../prisma.js", () => ({ prisma: {} }));
vi.mock("./brands.js", () => ({ cachedBrand: () => null, loadBrands: async () => undefined }));
vi.mock("./customerDirectory.js", () => ({ brandIdForOwner: async () => null }));
vi.mock("./tenantDb.js", () => ({ controlPlaneAsTenant: () => ({}), tenantFor: async () => ({}) }));
vi.mock("./notifications.js", () => ({ notifyIn: async () => undefined, notifyPlatformOwners: async () => undefined }));
vi.mock("./email.js", () => ({ sendTemplate: async () => true }));

import {
  alertLevel,
  billingLapsed,
  billingLocked,
  computeServiceHold,
  nextPeriodStart,
  usagePeriod,
  BRAND_BILLING_GRACE_DAYS,
} from "./brandUsage.js";

const DAY = 86_400_000;
const NOW = new Date("2026-09-29T12:00:00Z");
const ago = (days: number) => new Date(NOW.getTime() - days * DAY);

const brand = (over: Record<string, unknown> = {}) => ({
  platformFeeCents: 4900,
  purchasedFeatures: [],
  monthlyMinuteLimit: null as number | null,
  monthlyAiLimit: null as number | null,
  ...over,
});
const billing = (status: string, over: Record<string, unknown> = {}) => ({
  status,
  requiredSince: ago(1),
  pastDueSince: null as Date | null,
  ...over,
});

describe("billingLapsed / billingLocked", () => {
  it("never applies to a brand that owes nothing", () => {
    const free = brand({ platformFeeCents: 0 });
    expect(billingLapsed(free, billing("awaiting_card", { requiredSince: ago(90) }), NOW)).toBe(false);
    expect(billingLocked(free, billing("awaiting_card"), NOW)).toBe(false);
  });

  it("locks a never-paid brand's panel at once, but pauses its AI only after the grace period", () => {
    const fresh = billing("awaiting_card", { requiredSince: ago(2) });
    expect(billingLocked(brand(), fresh, NOW)).toBe(true);
    expect(billingLapsed(brand(), fresh, NOW)).toBe(false);
    const stale = billing("awaiting_card", { requiredSince: ago(BRAND_BILLING_GRACE_DAYS + 1) });
    expect(billingLapsed(brand(), stale, NOW)).toBe(true);
  });

  it("gives a failed renewal the grace period before locking anything", () => {
    const failing = billing("past_due", { pastDueSince: ago(3) });
    expect(billingLocked(brand(), failing, NOW)).toBe(false);
    expect(billingLapsed(brand(), failing, NOW)).toBe(false);
    const overdue = billing("past_due", { pastDueSince: ago(BRAND_BILLING_GRACE_DAYS + 1) });
    expect(billingLocked(brand(), overdue, NOW)).toBe(true);
  });

  it("counts a bought add-on as owing, even with no fee", () => {
    const addOnOnly = brand({ platformFeeCents: 0, purchasedFeatures: ["crm"] });
    expect(billingLocked(addOnOnly, billing("awaiting_card"), NOW)).toBe(true);
  });

  it("is clear when paid up", () => {
    expect(billingLocked(brand(), billing("active", { requiredSince: ago(400) }), NOW)).toBe(false);
  });
});

describe("computeServiceHold", () => {
  it("is empty with no caps and nothing owed", () => {
    expect(computeServiceHold(brand({ platformFeeCents: 0 }), null, { minutes: 9999, aiInteractions: 9999 }, NOW)).toBe("");
  });

  it("stops calls only when the minutes cap is reached", () => {
    const capped = brand({ monthlyMinuteLimit: 100 });
    expect(computeServiceHold(capped, billing("active"), { minutes: 99, aiInteractions: 5 }, NOW)).toBe("");
    expect(computeServiceHold(capped, billing("active"), { minutes: 100, aiInteractions: 5 }, NOW)).toBe("minutes");
  });

  it("ranks the AI cap above minutes, and billing above both", () => {
    const both = brand({ monthlyMinuteLimit: 10, monthlyAiLimit: 10 });
    const usage = { minutes: 50, aiInteractions: 50 };
    expect(computeServiceHold(both, billing("active"), usage, NOW)).toBe("ai");
    const lapsed = billing("past_due", { pastDueSince: ago(BRAND_BILLING_GRACE_DAYS + 2) });
    expect(computeServiceHold(both, lapsed, usage, NOW)).toBe("billing");
  });

  it("treats a cap of zero as already reached", () => {
    expect(computeServiceHold(brand({ monthlyAiLimit: 0 }), billing("active"), null, NOW)).toBe("ai");
  });
});

describe("alertLevel", () => {
  it("steps 0 → 80 → 100", () => {
    expect(alertLevel(79, 100)).toBe(0);
    expect(alertLevel(80, 100)).toBe(80);
    expect(alertLevel(100, 100)).toBe(100);
    expect(alertLevel(5000, null)).toBe(0);
  });
});

describe("usage periods", () => {
  it("are UTC calendar months", () => {
    expect(usagePeriod(new Date("2026-09-30T23:59:59Z"))).toBe("2026-09");
    expect(usagePeriod(new Date("2026-10-01T00:00:00Z"))).toBe("2026-10");
    expect(nextPeriodStart(new Date("2026-12-15T00:00:00Z")).toISOString()).toBe("2027-01-01T00:00:00.000Z");
  });
});
