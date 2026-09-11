import { describe, it, expect, vi, beforeEach } from "vitest";
import { HttpError } from "../lib/http.js";
import { prisma } from "../prisma.js";

/* ------------------------------------------------------------------ *
 *  Retry queue for config pushes to the live Vapi assistant.
 *
 *  Saving writes the DB first and pushes to Vapi second, so a provider outage
 *  costs nobody their edits — but it used to leave the owner looking at settings
 *  that real callers never heard, with nothing to close the gap. These tests pin
 *  the properties that make the queue safe to run unattended: it converges on the
 *  LATEST saved config, it backs off instead of hammering a provider that keeps
 *  saying no, and it repairs only — it never brings an assistant into existence.
 * ------------------------------------------------------------------ */

type Row = {
  id: string;
  userId: string;
  vapiAssistantId: string | null;
  agentConfig: unknown;
  vapiSyncAttempts: number;
};

// Typed args on the doubles so `mock.calls[n][0]` is a real shape rather than an
// empty tuple — the assertions below read fields straight off the Prisma args.
const h = vi.hoisted(() => ({
  vapiConfigured: true,
  findUnique: vi.fn(async (_args: unknown) => ({ vapiSyncPendingAt: null as Date | null, vapiSyncAttempts: 0 })),
  findMany: vi.fn(async (_args: { where: Record<string, unknown> }): Promise<Row[]> => []),
  update: vi.fn(async (_args: { where: unknown; data: Record<string, unknown> }) => ({})),
  updateMany: vi.fn(async (_args: { where: Record<string, unknown>; data: Record<string, unknown> }) => ({ count: 1 })),
  upsertAssistant: vi.fn(async (..._a: unknown[]): Promise<string> => "asst_live"),
  notifyAdmins: vi.fn(async (_n: unknown) => {}),
}));

/** Nth `conversion.update` payload, with a readable failure if it never ran. */
function updateData(n = 0): Record<string, unknown> {
  const call = h.update.mock.calls[n];
  if (!call) throw new Error(`conversion.update was not called ${n + 1} time(s)`);
  return call[0].data;
}

/** The `where` the sweep queried with. */
function findManyWhere(): Record<string, unknown> {
  const call = h.findMany.mock.calls[0];
  if (!call) throw new Error("conversion.findMany was never called");
  return call[0].where;
}

vi.mock("./settings.js", () => ({
  integrationsStatus: () => ({ vapi: h.vapiConfigured }),
}));
vi.mock("./vapi.js", () => ({ upsertAssistant: h.upsertAssistant }));
// One brand, whose database is the stand-in below.
vi.mock("./tenantDb.js", async () => {
  const { prisma } = await import("../prisma.js");
  return { allTenants: async () => [{ brandId: "b1", db: prisma }] };
});
vi.mock("./notifications.js", () => ({ notifyAdmins: h.notifyAdmins }));
vi.mock("../prisma.js", () => ({
  prisma: {
    conversion: {
      findUnique: h.findUnique,
      findMany: h.findMany,
      update: h.update,
      updateMany: h.updateMany,
    },
  },
}));

const { markVapiSyncPending, markVapiSynced, retryPendingVapiSyncs } = await import("./vapiSync.js");

/** A row the sweep would pick up: live assistant, already flagged pending. */
const pendingRow = (over: Record<string, unknown> = {}) => ({
  id: "conv1",
  userId: "user1",
  vapiAssistantId: "asst_live",
  agentConfig: { identity: { assistantName: "Mark" } },
  vapiSyncAttempts: 0,
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  h.vapiConfigured = true;
  h.findMany.mockResolvedValue([]);
  h.findUnique.mockResolvedValue({ vapiSyncPendingAt: null, vapiSyncAttempts: 0 });
});

describe("marking a config out of sync", () => {
  it("keeps the first divergence time across repeat failures", async () => {
    // The timestamp answers "how long have callers been on the old script", so a
    // later failure must not reset it to now and hide a days-old divergence.
    const first = new Date("2026-08-06T09:30:00Z");
    h.findUnique.mockResolvedValue({ vapiSyncPendingAt: first, vapiSyncAttempts: 2 });

    await markVapiSyncPending(prisma as never, "conv1", new Error("504 Gateway Timeout"));

    expect(updateData().vapiSyncPendingAt).toEqual(first);
    expect(updateData().vapiSyncAttempts).toBe(3);
  });

  it("backs off further on each consecutive failure, up to an hour", async () => {
    const nextAfter = async (attempts: number): Promise<number> => {
      h.update.mockClear();
      h.findUnique.mockResolvedValue({ vapiSyncPendingAt: new Date(), vapiSyncAttempts: attempts });
      await markVapiSyncPending(prisma as never, "conv1", new Error("boom"));
      return (updateData().vapiSyncNextAt as Date).getTime() - Date.now();
    };

    const firstRetry = await nextAfter(0);
    const secondRetry = await nextAfter(1);
    expect(secondRetry).toBeGreaterThan(firstRetry);

    // A config Vapi will never accept (a rejected field, say) would otherwise be
    // re-pushed every five minutes forever.
    const stuck = await nextAfter(50);
    expect(stuck).toBeLessThanOrEqual(60 * 60 * 1000);
  });

  it("parks a config Vapi rejected outright instead of queueing it", async () => {
    // The 400 that started this: an ElevenLabs voice id Vapi can't resolve. The
    // same payload will be rejected identically forever, so it stays flagged (the
    // account IS out of sync) but never re-pushed.
    await markVapiSyncPending(prisma as never, "conv1", new HttpError(400, "Couldn't Find 11labs Voice"));

    expect(updateData().vapiSyncNextAt).toBeNull();
    expect(updateData().vapiSyncPendingAt).toBeInstanceOf(Date);
  });

  it("still queues a rate-limit or timeout — those are timing, not content", async () => {
    await markVapiSyncPending(prisma as never, "conv1", new HttpError(429, "Too Many Requests"));
    expect(updateData().vapiSyncNextAt).toBeInstanceOf(Date);
  });

  it("queues an upstream 5xx and a bare network error", async () => {
    await markVapiSyncPending(prisma as never, "conv1", new HttpError(502, "Bad Gateway"));
    expect(updateData().vapiSyncNextAt).toBeInstanceOf(Date);

    h.update.mockClear();
    await markVapiSyncPending(prisma as never, "conv1", new Error("fetch failed"));
    expect(updateData().vapiSyncNextAt).toBeInstanceOf(Date);
  });

  it("never throws — it runs inside the catch of a save that already succeeded", async () => {
    h.findUnique.mockRejectedValue(new Error("db down"));
    await expect(markVapiSyncPending(prisma as never, "conv1", new Error("boom"))).resolves.toBeUndefined();
  });
});

describe("clearing the flag", () => {
  it("writes nothing when the account was already in sync", async () => {
    // Every successful save calls this, so the common path must not cost a write.
    await markVapiSynced(prisma as never, "conv1");
    expect(h.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "conv1", NOT: { vapiSyncPendingAt: null } } }),
    );
  });
});

describe("the retry sweep", () => {
  it("pushes the config saved NOW, not the payload that failed", async () => {
    // Saves during an outage keep landing in the DB, so replaying the original
    // payload would push a config the owner has since edited away.
    h.findMany.mockResolvedValue([pendingRow({ agentConfig: { identity: { assistantName: "Jess" } } })]);
    h.upsertAssistant.mockResolvedValue("asst_live");

    const result = await retryPendingVapiSyncs();

    expect(h.upsertAssistant).toHaveBeenCalledWith(
      { identity: { assistantName: "Jess" } },
      "asst_live",
      { ownerId: "user1" },
    );
    expect(result.recovered).toBe(1);
  });

  it("clears the pending flag once the push lands", async () => {
    h.findMany.mockResolvedValue([pendingRow()]);
    h.upsertAssistant.mockResolvedValue("asst_live");

    await retryPendingVapiSyncs();

    expect(h.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ vapiSyncPendingAt: null }) }),
    );
  });

  it("asks only for rows whose backoff has elapsed, skipping parked ones", async () => {
    // `lte` never matches SQL NULL, so a row parked by a 4xx is excluded by the
    // same clause that implements the backoff — no separate filter to keep in sync.
    await retryPendingVapiSyncs();
    const where = findManyWhere();
    expect(where.vapiSyncPendingAt).toEqual({ not: null });
    expect(where.vapiSyncNextAt).toEqual({ lte: expect.any(Date) });
  });

  it("only repairs accounts that already have a live assistant", async () => {
    // Provisioning is owned by picking a plan / claiming a number. If the sweep
    // pushed for an account with no assistant, upsertAssistant would CREATE one —
    // handing a live agent to someone who never qualified for it.
    await retryPendingVapiSyncs();
    expect(findManyWhere().vapiAssistantId).toEqual({ not: null });
  });

  it("persists a recreated assistant id so the number keeps routing", async () => {
    // upsertAssistant creates a fresh assistant when Vapi 404s the stored id.
    h.findMany.mockResolvedValue([pendingRow()]);
    h.upsertAssistant.mockResolvedValue("asst_recreated");

    await retryPendingVapiSyncs();

    expect(h.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { vapiAssistantId: "asst_recreated" } }),
    );
  });

  it("re-queues a row that fails again instead of dropping it", async () => {
    h.findMany.mockResolvedValue([pendingRow({ vapiSyncAttempts: 1 })]);
    h.upsertAssistant.mockRejectedValue(new Error("still down"));
    h.findUnique.mockResolvedValue({ vapiSyncPendingAt: new Date(), vapiSyncAttempts: 1 });

    const result = await retryPendingVapiSyncs();

    expect(result.recovered).toBe(0);
    expect(updateData().vapiSyncAttempts).toBe(2);
  });

  it("keeps draining the batch after one account fails", async () => {
    h.findMany.mockResolvedValue([
      pendingRow({ id: "conv1", userId: "user1" }),
      pendingRow({ id: "conv2", userId: "user2" }),
    ]);
    h.upsertAssistant
      .mockRejectedValueOnce(new Error("one bad config"))
      .mockResolvedValueOnce("asst_live");

    const result = await retryPendingVapiSyncs();

    expect(result.attempted).toBe(2);
    expect(result.recovered).toBe(1);
  });

  it("tells admins once, not on every tick, when an account stays stuck", async () => {
    h.upsertAssistant.mockRejectedValue(new Error("rejected"));
    h.findUnique.mockResolvedValue({ vapiSyncPendingAt: new Date(), vapiSyncAttempts: 4 });

    // The tick that crosses the threshold alerts...
    h.findMany.mockResolvedValue([pendingRow({ vapiSyncAttempts: 4 })]);
    await retryPendingVapiSyncs();
    expect(h.notifyAdmins).toHaveBeenCalledTimes(1);

    // ...every later one stays quiet, so a long outage can't flood the inbox.
    h.notifyAdmins.mockClear();
    h.findMany.mockResolvedValue([pendingRow({ vapiSyncAttempts: 9 })]);
    await retryPendingVapiSyncs();
    expect(h.notifyAdmins).not.toHaveBeenCalled();
  });

  it("does nothing when Vapi isn't configured at all", async () => {
    h.vapiConfigured = false;
    const result = await retryPendingVapiSyncs();
    expect(h.findMany).not.toHaveBeenCalled();
    expect(result).toEqual({ attempted: 0, recovered: 0 });
  });
});
