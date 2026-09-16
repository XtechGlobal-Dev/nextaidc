import { describe, it, expect, vi, beforeEach } from "vitest";

// Call log tiering. Mostly about what must never happen: a transcript destroyed because S3 was
// down, a recording that stops playing once its analysis moved, a re-run that orphans bucket objects.

const h = vi.hoisted(() => ({
  findMany: vi.fn(),
  update: vi.fn(),
  deleteMany: vi.fn(),
  put: vi.fn(),
  get: vi.fn(),
  del: vi.fn(),
  configured: vi.fn(() => true),
}));

// Calls live in a brand's own database, so every sweep takes that brand's
// client — this stands in for one.
const db = {
  callLog: { findMany: h.findMany, update: h.update, deleteMany: h.deleteMany },
} as never;
vi.mock("./storage.js", () => ({
  isStorageConfigured: h.configured,
  putJsonObject: h.put,
  getJsonObject: h.get,
  deleteObject: h.del,
}));
vi.mock("../env.js", () => ({
  // JWT_SECRET: retention deletes a call's personal half from the tenant DB, which pulls in credential crypto keyed off this.
  env: { CALL_ARCHIVE_AFTER_DAYS: 90, CALL_RETENTION_DAYS: 0, JWT_SECRET: "test-secret-for-the-call-archive-suite" },
}));

const {
  vapiCallIdOf,
  hydrateCall,
  blobKeyFor,
  archiveCallBlobs,
  pruneCallLogs,
  cacheArchivedTranslation,
} = await import("./callArchive.js");

/** One archivable row, with a transcript worth moving. */
function row(id = "call_1") {
  return {
    id,
    transcript: [{ role: "agent", text: "Hello", at: 0 }],
    analysis: { summary: "A call", vapiCallId: "vapi_1" },
    transcriptTranslated: null,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  h.configured.mockReturnValue(true);
  h.put.mockResolvedValue(undefined);
  h.del.mockResolvedValue(undefined);
  h.update.mockResolvedValue({});
});

describe("vapiCallIdOf", () => {
  it("prefers the promoted column", () => {
    expect(vapiCallIdOf({ vapiCallId: "col", analysis: { vapiCallId: "json" } })).toBe("col");
  });

  // The fallback is what makes the column safe to add: rows logged before it
  // existed keep working until the backfill reaches them.
  it("falls back to the analysis JSON for un-backfilled rows", () => {
    expect(vapiCallIdOf({ analysis: { vapiCallId: "json" } })).toBe("json");
  });

  it("returns null rather than a non-string when neither is usable", () => {
    expect(vapiCallIdOf({ analysis: { vapiCallId: 42 } })).toBeNull();
    expect(vapiCallIdOf({ vapiCallId: "", analysis: {} })).toBeNull();
    expect(vapiCallIdOf(null)).toBeNull();
  });

  // An archived call has an EMPTY analysis column — this is the case the whole
  // promotion exists for. Reading the JSON here would silently kill playback.
  it("still resolves once the analysis blob has been archived away", () => {
    expect(vapiCallIdOf({ vapiCallId: "vapi_1", analysis: {} })).toBe("vapi_1");
  });
});

describe("hydrateCall", () => {
  it("does not touch storage for a call that was never archived", async () => {
    const call = { id: "c1", blobKey: null, transcript: [{ text: "inline" }] };
    expect(await hydrateCall(call)).toBe(call);
    expect(h.get).not.toHaveBeenCalled();
  });

  it("fills the JSON columns back in from the blob", async () => {
    h.get.mockResolvedValue({
      transcript: [{ role: "agent", text: "restored", at: 0 }],
      analysis: { summary: "restored" },
      transcriptTranslated: null,
    });
    const out = await hydrateCall({
      id: "c1",
      blobKey: "call-blobs/c1.json",
      transcript: [],
      analysis: {},
    });
    expect(out.transcript).toEqual([{ role: "agent", text: "restored", at: 0 }]);
    expect(out.analysis).toEqual({ summary: "restored" });
  });

  // A lost object should cost one empty transcript panel, never a 500 on the
  // owner's inbox — every other field on the row is still correct.
  it("degrades to the un-hydrated row when the blob is gone", async () => {
    h.get.mockResolvedValue(null);
    const call = { id: "c1", blobKey: "call-blobs/c1.json", transcript: [], analysis: {} };
    expect(await hydrateCall(call)).toBe(call);
  });

  // `select` is partial on most read paths; hydrate must not invent columns the
  // caller never asked for, or Prisma-shaped objects gain phantom fields.
  it("only fills fields the caller actually selected", async () => {
    h.get.mockResolvedValue({ transcript: [{ text: "x" }], analysis: { a: 1 }, transcriptTranslated: null });
    const out = await hydrateCall({ id: "c1", blobKey: "k", transcript: [] });
    expect(out.transcript).toEqual([{ text: "x" }]);
    expect("analysis" in out).toBe(false);
  });
});

describe("archiveCallBlobs", () => {
  it("uploads the blobs, then empties the columns and records the key", async () => {
    h.findMany.mockResolvedValueOnce([row("call_1")]).mockResolvedValue([]);
    const result = await archiveCallBlobs(db, 90);

    expect(result.archived).toBe(1);
    expect(h.put).toHaveBeenCalledWith("call-blobs/call_1.json", {
      transcript: [{ role: "agent", text: "Hello", at: 0 }],
      analysis: { summary: "A call", vapiCallId: "vapi_1" },
      transcriptTranslated: null,
    });
    const data = h.update.mock.calls[0][0].data;
    expect(data.transcript).toEqual([]);
    expect(data.analysis).toEqual({});
    expect(data.blobKey).toBe("call-blobs/call_1.json");
  });

  // The ordering rule this feature lives or dies by: if the upload fails and we
  // had already emptied the columns, the transcript is gone for good.
  it("leaves the row untouched when the upload fails", async () => {
    h.findMany.mockResolvedValueOnce([row("call_1")]).mockResolvedValue([]);
    h.put.mockRejectedValue(new Error("S3 down"));

    const result = await archiveCallBlobs(db, 90);

    expect(result.archived).toBe(0);
    expect(result.failed).toBe(1);
    expect(h.update).not.toHaveBeenCalled();
  });

  it("stops sweeping when every upload in a batch fails", async () => {
    h.findMany.mockResolvedValue(Array.from({ length: 100 }, (_, i) => row(`c${i}`)));
    h.put.mockRejectedValue(new Error("S3 down"));

    await archiveCallBlobs(db, 90);

    // One batch attempted, then it gives up rather than grinding through all 50.
    expect(h.findMany).toHaveBeenCalledTimes(1);
  });

  it("is a no-op when archiving is switched off or storage is unconfigured", async () => {
    expect(await archiveCallBlobs(db, 0)).toEqual({ archived: 0, failed: 0, more: false });
    h.configured.mockReturnValue(false);
    expect(await archiveCallBlobs(db, 90)).toEqual({ archived: 0, failed: 0, more: false });
    expect(h.findMany).not.toHaveBeenCalled();
  });

  // Re-running must overwrite the call's own object, never scatter new ones.
  it("derives a stable key per call", () => {
    expect(blobKeyFor("abc")).toBe("call-blobs/abc.json");
    expect(blobKeyFor("abc")).toBe(blobKeyFor("abc"));
  });
});

describe("pruneCallLogs", () => {
  it("does nothing when retention is off, which is the default", async () => {
    expect(await pruneCallLogs(db, 0)).toBe(0);
    expect(h.findMany).not.toHaveBeenCalled();
  });

  // Row first would strand the object with nothing left pointing at it — a leak
  // that only grows, in the feature whose entire job is to stop growth.
  it("deletes the bucket object before the row that references it", async () => {
    const order: string[] = [];
    h.findMany.mockResolvedValueOnce([{ id: "c1", blobKey: "call-blobs/c1.json" }]).mockResolvedValue([]);
    h.del.mockImplementation(async () => void order.push("blob"));
    h.deleteMany.mockImplementation(async () => {
      order.push("row");
      return { count: 1 };
    });

    expect(await pruneCallLogs(db, 365)).toBe(1);
    expect(order).toEqual(["blob", "row"]);
  });

  it("skips the storage call for rows that were never archived", async () => {
    h.findMany.mockResolvedValueOnce([{ id: "c1", blobKey: null }]).mockResolvedValue([]);
    h.deleteMany.mockResolvedValue({ count: 1 });

    await pruneCallLogs(db, 365);

    expect(h.del).not.toHaveBeenCalled();
  });
});

describe("cacheArchivedTranslation", () => {
  // Writing the translation to the column instead would be masked by the next
  // hydrate, so every view would re-translate — and re-bill — the same call.
  it("rewrites the blob, preserving transcript and analysis", async () => {
    h.get.mockResolvedValue({
      transcript: [{ text: "original" }],
      analysis: { summary: "s" },
      transcriptTranslated: null,
    });

    await cacheArchivedTranslation("call-blobs/c1.json", [{ text: "traduit" }]);

    expect(h.put).toHaveBeenCalledWith("call-blobs/c1.json", {
      transcript: [{ text: "original" }],
      analysis: { summary: "s" },
      transcriptTranslated: [{ text: "traduit" }],
    });
  });

  it("writes nothing when the blob can't be read back", async () => {
    h.get.mockResolvedValue(null);
    await cacheArchivedTranslation("call-blobs/c1.json", [{ text: "traduit" }]);
    expect(h.put).not.toHaveBeenCalled();
  });
});
