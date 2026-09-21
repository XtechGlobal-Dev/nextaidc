import { describe, it, expect, vi, beforeEach } from "vitest";

// Which line a test call goes out on. The rule the product hangs on: a customer
// (or brand) that pays for a number dials from it; only those without one borrow
// the platform's. Getting the order wrong bills the wrong party and shows the
// wrong number on the handset.

process.env.DATABASE_URL ||= "postgresql://user:pass@localhost:5432/test";
process.env.JWT_SECRET ||= "test-secret-at-least-thirty-two-characters-long";

const h = vi.hoisted(() => ({
  findFirst: vi.fn(async (_args: unknown) => null as { number: string } | null),
  brandIdForOwner: vi.fn(async (_userId: string) => null as string | null),
  /** Platform-level values, keyed like the real settings cache. */
  platform: {} as Record<string, string>,
  /** Per-brand overrides: brandId -> key -> value. */
  brand: {} as Record<string, Record<string, string>>,
}));

vi.mock("../prisma.js", () => ({
  prisma: {
    phoneNumber: { findFirst: h.findFirst, findMany: vi.fn(), updateMany: vi.fn() },
    profile: { update: vi.fn() },
    platformSetting: { findUnique: vi.fn(async () => null) },
  },
}));
vi.mock("./tenantDb.js", async () =>
  (await import("../test/tenantDbFake.js")).tenantDbFake({}),
);
vi.mock("./customerDirectory.js", () => ({ brandIdForOwner: h.brandIdForOwner }));
vi.mock("./sms.js", () => ({
  isTwilioConfigured: () => true,
  listTwilioNumbersDetailed: vi.fn(),
  searchAvailableNumbers: vi.fn(),
  searchNumbersByPrefix: vi.fn(),
  purchaseNumber: vi.fn(),
  sendSms: vi.fn(),
  monthlyPriceCentsFor: vi.fn(async () => 500),
  describeSmsError: (e: unknown) => String(e),
  fetchSmsCapability: vi.fn(async () => true),
  releaseTwilioNumber: vi.fn(),
}));
vi.mock("./vapi.js", () => ({
  importTwilioNumber: vi.fn(),
  upsertAssistant: vi.fn(),
  releaseVapiNumber: vi.fn(),
}));
vi.mock("./settings.js", () => ({
  getEffective: (key: string) => h.platform[key] ?? "",
  getBrandOverride: (brandId: string, key: string) => h.brand[brandId]?.[key] ?? "",
  integrationsStatus: () => ({ vapi: true, twilio: true }),
  setSettingValue: vi.fn(async (key: string, value: string) => {
    h.platform[key] = value;
  }),
  saveBrandIntegrations: vi.fn(async (brandId: string, updates: Record<string, string>) => {
    for (const [key, value] of Object.entries(updates)) {
      h.brand[brandId] ??= {};
      if (value === "__inherit__") delete h.brand[brandId][key];
      else h.brand[brandId][key] = value;
    }
  }),
  INHERIT_SENTINEL: "__inherit__",
}));
vi.mock("./audit.js", () => ({ audit: vi.fn() }));

const { resolveOutboundCallerId, assignOutboundCaller, unassignOutboundCaller } =
  await import("./phones.js");

const PLATFORM = "+15550000001";
const BRAND = "+15550000002";
const OWN = "+61399990000";

beforeEach(() => {
  vi.clearAllMocks();
  h.platform = {};
  h.brand = {};
  h.findFirst.mockResolvedValue(null);
  h.brandIdForOwner.mockResolvedValue(null);
});

describe("resolveOutboundCallerId", () => {
  it("dials from the customer's own number ahead of everything else", async () => {
    h.findFirst.mockResolvedValue({ number: OWN });
    h.brandIdForOwner.mockResolvedValue("b_acme");
    h.brand.b_acme = { "twilio.outboundNumber": BRAND };
    h.platform["twilio.outboundNumber"] = PLATFORM;

    expect(await resolveOutboundCallerId("u_1")).toEqual({ number: OWN, source: "customer" });
  });

  it("only counts a number the customer actually holds", async () => {
    // A released number is still on the row until reassigned — ASSIGNED + active is
    // the only state that means "this line is theirs to dial from".
    h.findFirst.mockResolvedValue(null);
    h.platform["twilio.outboundNumber"] = PLATFORM;

    await resolveOutboundCallerId("u_1");
    expect(h.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId: "u_1", poolStatus: "ASSIGNED", status: "active" },
      }),
    );
  });

  it("falls back to the brand's number before the platform's", async () => {
    h.brandIdForOwner.mockResolvedValue("b_acme");
    h.brand.b_acme = { "twilio.outboundNumber": BRAND };
    h.platform["twilio.outboundNumber"] = PLATFORM;

    expect(await resolveOutboundCallerId("u_1")).toEqual({ number: BRAND, source: "brand" });
  });

  it("falls back to the platform number for a brand with no number of its own", async () => {
    h.brandIdForOwner.mockResolvedValue("b_acme");
    h.platform["twilio.outboundNumber"] = PLATFORM;

    expect(await resolveOutboundCallerId("u_1")).toEqual({ number: PLATFORM, source: "platform" });
  });

  it("returns null when nothing is configured, so the route can say why", async () => {
    expect(await resolveOutboundCallerId("u_1")).toBeNull();
  });

  it("survives a customer whose brand can't be resolved", async () => {
    h.brandIdForOwner.mockRejectedValue(new Error("tenant unavailable"));
    h.platform["twilio.outboundNumber"] = PLATFORM;

    expect(await resolveOutboundCallerId("u_1")).toEqual({ number: PLATFORM, source: "platform" });
  });
});

describe("assignOutboundCaller", () => {
  it("writes the platform value when no brand is acting", async () => {
    await assignOutboundCaller("+1 555 000 0001");
    expect(h.platform["twilio.outboundNumber"]).toBe(PLATFORM);
  });

  it("writes a brand override without touching the platform value", async () => {
    h.platform["twilio.outboundNumber"] = PLATFORM;
    await assignOutboundCaller(BRAND, "b_acme");

    expect(h.brand.b_acme["twilio.outboundNumber"]).toBe(BRAND);
    expect(h.platform["twilio.outboundNumber"]).toBe(PLATFORM);
  });

  it("rejects anything that isn't a phone number", async () => {
    await expect(assignOutboundCaller("not-a-number")).rejects.toThrow(/valid phone number/i);
  });
});

describe("unassignOutboundCaller", () => {
  it("drops a brand's override so it inherits the platform number again", async () => {
    h.platform["twilio.outboundNumber"] = PLATFORM;
    h.brand.b_acme = { "twilio.outboundNumber": BRAND };
    h.brandIdForOwner.mockResolvedValue("b_acme");

    await unassignOutboundCaller("b_acme");

    expect(h.brand.b_acme["twilio.outboundNumber"]).toBeUndefined();
    expect(await resolveOutboundCallerId("u_1")).toEqual({ number: PLATFORM, source: "platform" });
  });

  it("blanks the platform value rather than deleting it, so .env can't resurface it", async () => {
    h.platform["twilio.outboundNumber"] = PLATFORM;
    await unassignOutboundCaller(null);
    expect(h.platform["twilio.outboundNumber"]).toBe("");
  });
});
