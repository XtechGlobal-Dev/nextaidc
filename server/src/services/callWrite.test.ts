import { describe, it, expect, vi, beforeEach } from "vitest";

// A brand's calls live only in the brand's database. Pins that the row goes to that tenant
// client and the share index is the only thing written to the control plane.

const h = vi.hoisted(() => ({
  callDb: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  shareUpsert: vi.fn(),
  controlCreate: vi.fn(),
}));

vi.mock("./tenantDb.js", () => ({ callDb: h.callDb }));
vi.mock("../prisma.js", () => ({
  prisma: { callShare: { upsert: h.shareUpsert }, callLog: { create: h.controlCreate } },
}));

const { createCall, updateCall } = await import("./callWrite.js");

const CREATED_AT = new Date("2026-09-01T10:00:00.000Z");
const tenant = { callLog: { create: h.create, update: h.update } };

/** A call as the webhook would record it — brandId included, the way callers
 *  still build the payload with the control plane's types. */
const payload = {
  conversionId: "conv_1",
  brandId: "b_acme",
  callerName: "Jane Roe",
  callerNumber: "+61400000000",
  summary: "Wants a quote for a rewire",
  transcript: [{ role: "caller", text: "Hi, I need a quote", at: 0 }],
  analysis: { sentiment: "Positive" },
  durationSec: 90,
  publicId: "Xa7bK2p9",
  shareExpiresAt: new Date("2026-10-01T10:00:00.000Z"),
};

beforeEach(() => {
  vi.clearAllMocks();
  h.callDb.mockResolvedValue(tenant);
  h.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
    id: "call_1",
    createdAt: CREATED_AT,
    ...data,
  }));
  h.shareUpsert.mockResolvedValue({});
});

describe("createCall", () => {
  it("writes the whole call to the brand's own database, without a brand column", async () => {
    await createCall("b_acme", payload as never);

    expect(h.callDb).toHaveBeenCalledWith("b_acme");
    const { brandId: _dropped, ...row } = payload;
    expect(h.create).toHaveBeenCalledWith({ data: row });
    expect(h.controlCreate).not.toHaveBeenCalled();
  });

  it("indexes the share slug in the control plane, pointing at the brand", async () => {
    await createCall("b_acme", payload as never);

    expect(h.shareUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { publicId: "Xa7bK2p9" },
        create: {
          publicId: "Xa7bK2p9",
          brandId: "b_acme",
          callId: "call_1",
          callCreatedAt: CREATED_AT,
          expiresAt: payload.shareExpiresAt,
        },
      }),
    );
  });

  it("writes no share row for a call with no slug", async () => {
    const { publicId: _p, shareExpiresAt: _s, ...noShare } = payload;
    await createCall("b_acme", noShare as never);
    expect(h.shareUpsert).not.toHaveBeenCalled();
  });

  // The failure that matters: a brand whose database is not ready must get an
  // error, never a write somewhere else.
  it("refuses when the brand's database is not available, writing nothing", async () => {
    h.callDb.mockRejectedValue(new Error("not ready"));
    await expect(createCall("b_new", payload as never)).rejects.toThrow("not ready");
    expect(h.create).not.toHaveBeenCalled();
    expect(h.controlCreate).not.toHaveBeenCalled();
    expect(h.shareUpsert).not.toHaveBeenCalled();
  });
});

describe("updateCall", () => {
  it("updates by the full partitioned key, in the brand's database", async () => {
    const key = { id: "call_1", createdAt: CREATED_AT };
    await updateCall("b_acme", key, { summary: "Corrected" });

    expect(h.callDb).toHaveBeenCalledWith("b_acme");
    expect(h.update).toHaveBeenCalledWith({ where: { id_createdAt: key }, data: { summary: "Corrected" } });
  });
});
