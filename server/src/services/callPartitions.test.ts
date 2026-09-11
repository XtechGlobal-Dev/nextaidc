import { describe, it, expect, vi, beforeEach } from "vitest";

/* ------------------------------------------------------------------ *
 *  Partition maintenance. Two things here can lose data if they are
 *  wrong, and both are tested directly:
 *
 *    - provisioning too few months ahead → live calls fall into the
 *      catch-all partition, which nothing ever drops;
 *    - dropping a partition that straddles the retention cutoff → calls
 *      the operator explicitly asked to keep are gone, instantly and
 *      unrecoverably, because DROP TABLE does not do half a month.
 * ------------------------------------------------------------------ */

const h = vi.hoisted(() => ({
  queryRaw: vi.fn(),
  queryRawUnsafe: vi.fn(),
  execRaw: vi.fn(),
  execRawUnsafe: vi.fn(),
}));

vi.mock("../prisma.js", () => ({
  prisma: {
    $queryRaw: h.queryRaw,
    $queryRawUnsafe: h.queryRawUnsafe,
    $executeRaw: h.execRaw,
    $executeRawUnsafe: h.execRawUnsafe,
  },
}));
vi.mock("../env.js", () => ({ env: { CALL_RETENTION_DAYS: 0 } }));

const { sweepCallPartitions } = await import("./callPartitions.js");

/**
 * The service issues several distinct tagged-template queries. They're told
 * apart by the SQL text so each test can answer them independently.
 */
function mockDb(opts: {
  partitioned?: boolean;
  existing?: string[];
  defaultRows?: number;
}) {
  const existing = new Set(opts.existing ?? []);
  h.queryRaw.mockImplementation((strings: TemplateStringsArray, ...values: unknown[]) => {
    const sql = strings.join("?");
    if (sql.includes("pg_partitioned_table")) {
      return Promise.resolve([{ count: opts.partitioned === false ? 0n : 1n }]);
    }
    if (sql.includes("FROM pg_class c") && sql.includes("c.relname =")) {
      return Promise.resolve([{ count: existing.has(String(values[0])) ? 1n : 0n }]);
    }
    if (sql.includes("pg_inherits")) {
      return Promise.resolve([...existing].sort().map((relname) => ({ relname })));
    }
    return Promise.resolve([]);
  });
  // The catch-all count is the one query built by string rather than template,
  // because the table name varies (the same name in every plane).
  h.queryRawUnsafe.mockResolvedValue([{ count: BigInt(opts.defaultRows ?? 0) }]);
  h.execRawUnsafe.mockResolvedValue(0);
  return existing;
}

beforeEach(() => vi.clearAllMocks());

describe("provisioning months ahead", () => {
  it("creates the current month plus a two-month buffer", async () => {
    mockDb({ existing: [] });
    const result = await sweepCallPartitions(0, new Date("2026-09-04T00:00:00Z"));

    expect(result.created).toEqual([
      "call_logs_2026_09",
      "call_logs_2026_10",
      "call_logs_2026_11",
    ]);
  });

  it("rolls the year over correctly at the end of December", async () => {
    mockDb({ existing: [] });
    const result = await sweepCallPartitions(0, new Date("2026-12-15T00:00:00Z"));

    expect(result.created).toEqual([
      "call_logs_2026_12",
      "call_logs_2027_01",
      "call_logs_2027_02",
    ]);
  });

  it("uses half-open month bounds so no call falls between two partitions", async () => {
    mockDb({ existing: [] });
    await sweepCallPartitions(0, new Date("2026-09-04T00:00:00Z"));

    const ddl = h.execRawUnsafe.mock.calls.map((c) => String(c[0]));
    expect(ddl[0]).toContain(`FOR VALUES FROM ('2026-09-01') TO ('2026-10-01')`);
    // The upper bound of one month is the exact lower bound of the next.
    expect(ddl[1]).toContain(`FOR VALUES FROM ('2026-10-01') TO ('2026-11-01')`);
  });

  it("is idempotent — months that already exist are not recreated", async () => {
    mockDb({ existing: ["call_logs_2026_09", "call_logs_2026_10", "call_logs_2026_11"] });
    const result = await sweepCallPartitions(0, new Date("2026-09-04T00:00:00Z"));

    expect(result.created).toEqual([]);
    expect(h.execRawUnsafe).not.toHaveBeenCalled();
  });

  it("does nothing at all on a database that was never partitioned", async () => {
    mockDb({ partitioned: false });
    const result = await sweepCallPartitions(0, new Date("2026-09-04T00:00:00Z"));

    expect(result).toEqual({ created: [], dropped: [], defaultRows: 0 });
    expect(h.execRawUnsafe).not.toHaveBeenCalled();
  });
});

describe("dropping expired months", () => {
  // 400 days back from 2026-09-04 is 2025-07-31, so July 2025 still holds
  // retained calls (the 31st) and only June and earlier may go.
  it("keeps a partition that straddles the retention cutoff", async () => {
    mockDb({
      existing: [
        "call_logs_2025_05",
        "call_logs_2025_06",
        "call_logs_2025_07",
        "call_logs_2026_09",
      ],
    });
    const result = await sweepCallPartitions(400, new Date("2026-09-04T00:00:00Z"));

    expect(result.dropped).toEqual(["call_logs_2025_05", "call_logs_2025_06"]);
    expect(result.dropped).not.toContain("call_logs_2025_07");
  });

  it("detaches before dropping, so a mistake is briefly recoverable", async () => {
    mockDb({ existing: ["call_logs_2020_01", "call_logs_2026_09"] });
    await sweepCallPartitions(365, new Date("2026-09-04T00:00:00Z"));

    const ddl = h.execRawUnsafe.mock.calls.map((c) => String(c[0]));
    const detach = ddl.findIndex((s) => s.includes("DETACH PARTITION"));
    const drop = ddl.findIndex((s) => s.includes("DROP TABLE"));
    expect(detach).toBeGreaterThanOrEqual(0);
    expect(drop).toBeGreaterThan(detach);
  });

  it("drops nothing when retention is off, which is the default", async () => {
    mockDb({ existing: ["call_logs_2015_01", "call_logs_2026_09"] });
    const result = await sweepCallPartitions(0, new Date("2026-09-04T00:00:00Z"));

    expect(result.dropped).toEqual([]);
  });

  it("never touches the catch-all partition", async () => {
    mockDb({ existing: ["call_logs_2015_01", "call_logs_default", "call_logs_2026_09"] });
    const result = await sweepCallPartitions(365, new Date("2026-09-04T00:00:00Z"));

    expect(result.dropped).not.toContain("call_logs_default");
  });
});

describe("catch-all monitoring", () => {
  // Rows here are not lost, but they sit in a partition no drop will ever
  // reclaim — so the sweep surfaces the count rather than staying silent.
  it("reports rows that fell into the default partition", async () => {
    mockDb({ existing: ["call_logs_2026_09"], defaultRows: 17 });
    const result = await sweepCallPartitions(0, new Date("2026-09-04T00:00:00Z"));

    expect(result.defaultRows).toBe(17);
  });

  it("reports zero on a healthy table", async () => {
    mockDb({ existing: ["call_logs_2026_09"], defaultRows: 0 });
    const result = await sweepCallPartitions(0, new Date("2026-09-04T00:00:00Z"));

    expect(result.defaultRows).toBe(0);
  });
});
