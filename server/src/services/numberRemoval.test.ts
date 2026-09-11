import { describe, it, expect, vi, beforeEach } from "vitest";

/* ------------------------------------------------------------------ *
 *  Permanent number removal.
 *
 *  When a customer discontinues and their warning window expires, the
 *  number goes back to Twilio for good — it does NOT land in a pool.
 *  This is the one path in the codebase that destroys an asset the
 *  platform pays for, so the order of operations and the failure
 *  behaviour both matter more than usual.
 * ------------------------------------------------------------------ */

process.env.DATABASE_URL ||= "postgresql://user:pass@localhost:5432/test";
process.env.JWT_SECRET ||= "test-secret-at-least-thirty-two-characters-long";

/** Mocks are declared with the arguments they actually receive: a bare
 *  `vi.fn(async () => x)` types as zero-arity, so passing anything to it fails
 *  the typecheck even though the test runs fine. */
const h = vi.hoisted(() => ({
  findMany: vi.fn(),
  deleteNumber: vi.fn(async (_args: unknown) => ({})),
  updateProfile: vi.fn(async (_args: unknown) => ({})),
  releaseTwilio: vi.fn(async (_args: unknown): Promise<boolean> => true),
  releaseVapi: vi.fn(async (_number: string) => undefined),
  audit: vi.fn(async (_event: Record<string, unknown>) => undefined),
  settingFindUnique: vi.fn(async () => null as { value: string } | null),
  updateManyNumbers: vi.fn(
    async (_args: { where?: Record<string, unknown>; data?: Record<string, unknown> }) => ({
      count: 0,
    }),
  ),
  /** Every side effect in the order it happened, so ordering is testable. */
  order: [] as string[],
}));

vi.mock("../prisma.js", () => ({
  prisma: {
    phoneNumber: {
      findMany: h.findMany,
      updateMany: h.updateManyNumbers,
      delete: vi.fn(async (args: unknown) => {
        h.order.push("db.delete");
        return h.deleteNumber(args);
      }),
    },
    profile: { update: h.updateProfile },
    platformSetting: { findUnique: h.settingFindUnique },
  },
}));
vi.mock("./tenantDb.js", async () =>
  (await import("../test/tenantDbFake.js")).tenantDbFake({}),
);

vi.mock("./sms.js", () => ({
  isTwilioConfigured: () => true,
  releaseTwilioNumber: vi.fn(async (args: unknown) => {
    h.order.push("twilio.release");
    return h.releaseTwilio(args);
  }),
  listTwilioNumbersDetailed: vi.fn(async () => []),
  searchAvailableNumbers: vi.fn(),
  searchNumbersByPrefix: vi.fn(),
  purchaseNumber: vi.fn(),
  sendSms: vi.fn(),
  monthlyPriceCentsFor: vi.fn(async () => 500),
  describeSmsError: (e: unknown) => String(e),
  fetchSmsCapability: vi.fn(async () => true),
}));

vi.mock("./vapi.js", () => ({
  importTwilioNumber: vi.fn(),
  upsertAssistant: vi.fn(),
  releaseVapiNumber: vi.fn(async (n: string) => {
    h.order.push("vapi.release");
    return h.releaseVapi(n);
  }),
}));

vi.mock("./settings.js", () => ({
  getEffective: () => "",
  integrationsStatus: () => ({ vapi: true, twilio: true }),
  setSettingValue: vi.fn(),
}));

vi.mock("./audit.js", () => ({ audit: h.audit }));

const { releaseNumberPermanently } = await import("./phones.js");
const sms = await import("./sms.js");

const ROW = {
  id: "pn_1",
  number: "+61399990000",
  twilioSid: "PN123",
  brandId: "b_acme",
};

beforeEach(() => {
  vi.clearAllMocks();
  h.order.length = 0;
  h.findMany.mockResolvedValue([ROW]);
  h.releaseTwilio.mockResolvedValue(true);
});

describe("releaseNumberPermanently", () => {
  it("hands the number back to Twilio and deletes the row", async () => {
    const freed = await releaseNumberPermanently("u_1");

    expect(sms.releaseTwilioNumber).toHaveBeenCalledWith({ sid: "PN123", number: ROW.number });
    expect(h.deleteNumber).toHaveBeenCalledWith({ where: { id: "pn_1" } });
    expect(freed).toBe(ROW.number);
  });

  it("never leaves the number in a pool", async () => {
    // The whole point: this is not a release-to-pool. If the row survived with
    // AVAILABLE it would show in the brand's pool while the carrier has it back.
    await releaseNumberPermanently("u_1");
    expect(h.deleteNumber).toHaveBeenCalledOnce();
  });

  it("drops Vapi routing before giving up the number", async () => {
    // Reversed, an assistant would briefly point at a number someone else can
    // already buy.
    await releaseNumberPermanently("u_1");
    expect(h.order.indexOf("vapi.release")).toBeLessThan(h.order.indexOf("twilio.release"));
    expect(h.order.indexOf("twilio.release")).toBeLessThan(h.order.indexOf("db.delete"));
  });

  it("keeps the row when Twilio refuses, so we never lose a number we still pay for", async () => {
    h.releaseTwilio.mockRejectedValue(new Error("Twilio 500"));
    const freed = await releaseNumberPermanently("u_1");

    expect(h.deleteNumber).not.toHaveBeenCalled();
    // Still reports the number so the notification the sweep sends isn't blank.
    expect(freed).toBe(ROW.number);
  });

  it("clears the customer's receptionist number", async () => {
    await releaseNumberPermanently("u_1");
    expect(h.updateProfile).toHaveBeenCalledWith({
      where: { userId: "u_1" },
      data: { receptionistNumber: "", phoneNumberId: null },
    });
  });

  it("records what was given up, since the row itself is gone", async () => {
    await releaseNumberPermanently("u_1");
    const entry = h.audit.mock.calls[0]?.[0] as unknown as {
      action: string;
      targetId: string;
      metadata: { brandId: string; reason: string };
    };
    expect(entry.action).toBe("phone.released_permanently");
    expect(entry.targetId).toBe(ROW.number);
    expect(entry.metadata.brandId).toBe("b_acme");
    expect(entry.metadata.reason).toBe("grace_period_expired");
  });

  it("is a no-op for a customer who holds no number", async () => {
    h.findMany.mockResolvedValue([]);
    const freed = await releaseNumberPermanently("u_1");
    expect(freed).toBeNull();
    expect(sms.releaseTwilioNumber).not.toHaveBeenCalled();
    expect(h.deleteNumber).not.toHaveBeenCalled();
  });
});

/* ------------------------------------------------------------------ *
 *  Brand reclaim — "use it or lose it".
 *
 *  A number a brand unassigns is theirs to reuse, but not forever: if
 *  they don't, the platform takes it back into the shared pool. The
 *  sweep that does it runs hourly against live inventory, so the filter
 *  it applies is worth pinning down exactly.
 * ------------------------------------------------------------------ */

const { sweepBrandReclaims, getReclaimDays } = await import("./phones.js");

describe("brand reclaim window", () => {
  it("defaults to 7 days when nothing is configured", async () => {
    h.settingFindUnique.mockResolvedValue(null);
    expect(await getReclaimDays()).toBe(7);
  });

  it("honours a configured window", async () => {
    h.settingFindUnique.mockResolvedValue({ value: "3" });
    expect(await getReclaimDays()).toBe(3);
  });

  it("still allows a deliberate zero", async () => {
    h.settingFindUnique.mockResolvedValue({ value: "0" });
    expect(await getReclaimDays()).toBe(0);
  });

  it("ignores a nonsense or blank window rather than stripping brand inventory", async () => {
    // "" matters most: Number("") is 0, and 0 is a legitimate value here
    // ("reclaim on the next sweep"). A cleared field must not mean that.
    for (const bad of ["-1", "9999", "abc", "", "  "]) {
      h.settingFindUnique.mockResolvedValue({ value: bad });
      expect({ bad, days: await getReclaimDays() }).toEqual({ bad, days: 7 });
    }
  });

  it("only reclaims numbers that are unassigned, branded and past the window", async () => {
    h.settingFindUnique.mockResolvedValue({ value: "7" });
    await sweepBrandReclaims();

    const where = (h.updateManyNumbers.mock.calls[0]?.[0]?.where ?? {}) as Record<string, unknown>;
    // userId null is the safety clause: reclaiming a number mid-call would be
    // the worst bug in this file.
    expect(where.userId).toBeNull();
    expect(where.brandId).toEqual({ not: null });
    expect(where.poolStatus).toBe("AVAILABLE");
    expect((where.releasedAt as { lte: Date }).lte).toBeInstanceOf(Date);
  });

  it("clears the brand and the clock when it reclaims", async () => {
    h.settingFindUnique.mockResolvedValue({ value: "7" });
    await sweepBrandReclaims();

    const data = (h.updateManyNumbers.mock.calls[0]?.[0]?.data ?? {}) as Record<string, unknown>;
    expect(data.brandId).toBeNull();
    expect(data.releasedAt).toBeNull();
    expect(data.poolStatus).toBe("AVAILABLE");
  });
});
