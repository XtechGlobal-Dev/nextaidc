import { describe, it, expect, vi, beforeEach } from "vitest";

// The active-customer rule: warn once in a month's last week, downgrade on the 7th of the next month if a brand
// still has no active customer, clear the warning as soon as one appears, and never hold a brand to it before its
// first full month.

const h = vi.hoisted(() => ({
  brands: [] as Record<string, unknown>[],
  active: 0,
  update: vi.fn(async (_a: { where: { id: string }; data: Record<string, unknown> }) => ({})),
  downgrade: vi.fn(async (_id: string, _o: unknown) => ({})),
  sendTemplate: vi.fn(async (..._a: unknown[]) => true),
  notify: vi.fn(async (..._a: unknown[]) => undefined),
  notifyPlatformOwners: vi.fn(async (..._a: unknown[]) => undefined),
  count: vi.fn(async (_a: { where: Record<string, unknown> }) => h.active),
}));

vi.mock("../prisma.js", () => ({
  prisma: {
    brand: { findMany: vi.fn(async () => h.brands), update: h.update },
    customerDirectory: { findUnique: vi.fn(async () => ({ email: "jo@acme.com", fullName: "Jo" })) },
  },
}));
vi.mock("./tenantDb.js", () => ({ tenantFor: async () => ({ profile: { count: h.count } }) }));
vi.mock("./brands.js", () => ({ brandOrigin: () => "https://acme.example.com" }));
vi.mock("./email.js", () => ({ sendTemplate: h.sendTemplate }));
vi.mock("./notifications.js", () => ({ notify: h.notify, notifyPlatformOwners: h.notifyPlatformOwners }));
vi.mock("./brandLifecycle.js", () => ({ downgradeToCustomer: h.downgrade }));

import { deadlineFor, inWarningWindow, runBrandEligibilityCheck } from "./brandEligibility.js";

const brand = (over: Record<string, unknown> = {}) => ({
  id: "b1",
  slug: "acme",
  name: "Acme",
  kind: "brand",
  status: "active",
  ownerUserId: "owner",
  brandSince: new Date("2026-08-10T00:00:00Z"),
  statusWarnedFor: "",
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  h.brands = [];
  h.active = 0;
});

describe("the calendar", () => {
  it("warns only in the last 7 days of a month", () => {
    expect(inWarningWindow(new Date("2026-10-24T12:00:00Z"))).toBe(false);
    expect(inWarningWindow(new Date("2026-10-25T12:00:00Z"))).toBe(true);
    expect(inWarningWindow(new Date("2026-02-22T12:00:00Z"))).toBe(true); // 28-day February
  });

  it("gives until the 7th of the next month, across a year end", () => {
    expect(deadlineFor("2026-10").toISOString().slice(0, 10)).toBe("2026-11-07");
    expect(deadlineFor("2026-12").toISOString().slice(0, 10)).toBe("2027-01-07");
  });
});

describe("runBrandEligibilityCheck", () => {
  it("warns a brand with no active customer in the last week, once", async () => {
    h.brands = [brand()];
    const out = await runBrandEligibilityCheck(new Date("2026-10-27T09:00:00Z"));
    expect(out.warned).toEqual(["acme"]);
    expect(h.update.mock.calls[0][0].data).toEqual({ statusWarnedFor: "2026-10" });
    expect(h.sendTemplate).toHaveBeenCalledWith(
      "brand_admin_status_warning",
      "jo@acme.com",
      expect.objectContaining({ deadline: "November 7, 2026" }),
    );

    h.brands = [brand({ statusWarnedFor: "2026-10" })];
    vi.clearAllMocks();
    const again = await runBrandEligibilityCheck(new Date("2026-10-28T09:00:00Z"));
    expect(again.warned).toEqual([]);
    expect(h.sendTemplate).not.toHaveBeenCalled();
  });

  it("never counts the owner's own account", async () => {
    h.brands = [brand()];
    await runBrandEligibilityCheck(new Date("2026-10-27T09:00:00Z"));
    expect(h.count.mock.calls[0][0].where).toMatchObject({ user: { role: "USER", id: { not: "owner" } } });
  });

  it("leaves a brand alone outside the last week", async () => {
    h.brands = [brand()];
    const out = await runBrandEligibilityCheck(new Date("2026-10-15T09:00:00Z"));
    expect(out).toEqual({ warned: [], cleared: [], downgraded: [], failed: [] });
    expect(h.count).not.toHaveBeenCalled();
  });

  it("doesn't hold a brand to the rule in the month it became one", async () => {
    h.brands = [brand({ brandSince: new Date("2026-10-20T00:00:00Z") })];
    const out = await runBrandEligibilityCheck(new Date("2026-10-27T09:00:00Z"));
    expect(out.warned).toEqual([]);
  });

  it("downgrades on the 7th when last month's warning wasn't answered", async () => {
    h.brands = [brand({ statusWarnedFor: "2026-10" })];
    const out = await runBrandEligibilityCheck(new Date("2026-11-07T09:00:00Z"));
    expect(out.downgraded).toEqual(["acme"]);
    expect(h.downgrade).toHaveBeenCalledWith("b1", { reason: "no_active_customers" });
  });

  it("waits until the 7th", async () => {
    h.brands = [brand({ statusWarnedFor: "2026-10" })];
    const out = await runBrandEligibilityCheck(new Date("2026-11-06T09:00:00Z"));
    expect(out.downgraded).toEqual([]);
    expect(h.downgrade).not.toHaveBeenCalled();
  });

  it("still downgrades a brand whose warning is older (a missed run)", async () => {
    h.brands = [brand({ statusWarnedFor: "2026-09" })];
    const out = await runBrandEligibilityCheck(new Date("2026-11-02T09:00:00Z"));
    expect(out.downgraded).toEqual(["acme"]);
  });

  it("clears the warning once a customer is active again — and never downgrades then", async () => {
    h.brands = [brand({ statusWarnedFor: "2026-10" })];
    h.active = 1;
    const out = await runBrandEligibilityCheck(new Date("2026-11-07T09:00:00Z"));
    expect(out.cleared).toEqual(["acme"]);
    expect(out.downgraded).toEqual([]);
    expect(h.update.mock.calls[0][0].data).toEqual({ statusWarnedFor: "" });
  });

  it("counts paid, past-due and live trials as active", async () => {
    h.brands = [brand()];
    const now = new Date("2026-10-27T09:00:00Z");
    await runBrandEligibilityCheck(now);
    const where = h.count.mock.calls[0][0].where as { OR: unknown[] };
    expect(where.OR).toEqual([
      { subscriptionStatus: { in: ["active", "past_due", "trialing"] } },
      { trialStartedAt: { not: null }, trialStatus: "active", trialEndsAt: { gt: now } },
    ]);
  });

  it("keeps going when one brand's database fails", async () => {
    h.brands = [brand({ id: "b1", slug: "broken" }), brand({ id: "b2", slug: "fine" })];
    h.count.mockRejectedValueOnce(new Error("compute asleep"));
    const out = await runBrandEligibilityCheck(new Date("2026-10-27T09:00:00Z"));
    expect(out.failed).toEqual(["broken"]);
    expect(out.warned).toEqual(["fine"]);
  });
});
