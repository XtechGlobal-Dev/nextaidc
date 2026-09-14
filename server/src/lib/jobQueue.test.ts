import { describe, it, expect, vi, beforeEach } from "vitest";

/* ------------------------------------------------------------------ *
 *  Thin dispatch-layer test: confirms scheduleRecurring wires the right
 *  handler to the right cron/queue name via pg-boss, without needing a
 *  live Postgres instance. The migrated jobs' own business logic (e.g.
 *  pruneApiRequestLogs, evaluateAlertRules) is covered by their own tests
 *  and is untouched by this workstream.
 * ------------------------------------------------------------------ */

const h = vi.hoisted(() => {
  const createQueue = vi.fn().mockResolvedValue(undefined);
  const work = vi.fn().mockResolvedValue("worker-id");
  const schedule = vi.fn().mockResolvedValue(undefined);
  const on = vi.fn();
  class MockPgBoss {
    createQueue = createQueue;
    work = work;
    schedule = schedule;
    on = on;
    async start() {
      return this;
    }
  }
  return { createQueue, work, schedule, on, MockPgBoss };
});

vi.mock("pg-boss", () => ({ default: h.MockPgBoss }));
vi.mock("../env.js", () => ({
  env: { DATABASE_URL: "postgres://test/db", JOB_QUEUE_DB_URL: "", JOB_QUEUE_SCHEMA: "pgboss" },
}));

const { scheduleRecurring } = await import("./jobQueue.js");

describe("scheduleRecurring", () => {
  beforeEach(() => {
    h.createQueue.mockClear();
    h.work.mockClear();
    h.schedule.mockClear();
  });

  it("creates the queue, wires the handler as the worker, and schedules the cron in UTC", async () => {
    const handler = vi.fn().mockResolvedValue(undefined);
    await scheduleRecurring("api-log-sweep", "0 0 * * *", handler);

    expect(h.createQueue).toHaveBeenCalledWith("api-log-sweep");
    expect(h.work).toHaveBeenCalledWith("api-log-sweep", expect.any(Function));
    expect(h.schedule).toHaveBeenCalledWith("api-log-sweep", "0 0 * * *", undefined, { tz: "UTC" });

    // The worker pg-boss was handed must delegate to the given handler.
    const workerFn = h.work.mock.calls[0]![1] as (jobs: unknown) => Promise<void>;
    await workerFn([{ id: "1", data: {} }]);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("passes singletonKey through so an overlapping run is refused, not queued", async () => {
    await scheduleRecurring("vapi-sync", "*/30 * * * *", vi.fn(), { singletonKey: "vapi-sync-lock" });

    expect(h.schedule).toHaveBeenCalledWith("vapi-sync", "*/30 * * * *", undefined, {
      tz: "UTC",
      singletonKey: "vapi-sync-lock",
    });
  });
});
