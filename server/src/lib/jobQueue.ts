/* ------------------------------------------------------------------ *
 *  A thin wrapper around pg-boss, our scheduled-job queue.
 *
 *  Backed by the existing main Postgres database (its own "pgboss" schema,
 *  additive — no Prisma migration involved) rather than Redis/BullMQ: the
 *  codebase has zero Redis footprint today, and this workload (a dozen
 *  recurring jobs, none faster than once a minute) doesn't need Redis-grade
 *  throughput.
 *
 *  Unlike scheduler.ts's setInterval jobs, a job registered here runs on
 *  exactly one instance per firing even when multiple server processes are
 *  running — pg-boss claims each job via `SELECT ... FOR UPDATE SKIP LOCKED`,
 *  so only one instance's poll ever wins a given scheduled tick.
 * ------------------------------------------------------------------ */
import PgBoss from "pg-boss";
import { env } from "../env.js";

const globalForBoss = globalThis as unknown as { pgBoss?: PgBoss };

function createBoss(): PgBoss {
  return new PgBoss({
    connectionString: env.JOB_QUEUE_DB_URL || env.DATABASE_URL,
    schema: env.JOB_QUEUE_SCHEMA,
  });
}

let starting: Promise<PgBoss> | null = null;

/** Lazily creates and starts the shared pg-boss instance (once per process). */
export function getBoss(): Promise<PgBoss> {
  if (!starting) {
    const boss = globalForBoss.pgBoss ?? createBoss();
    if (process.env.NODE_ENV !== "production") globalForBoss.pgBoss = boss;
    boss.on("error", (err) => console.error("[jobQueue] pg-boss error:", err));
    starting = boss.start();
  }
  return starting;
}

/**
 * Registers a recurring job on a cron schedule: creates its queue if missing,
 * wires `handler` as the worker, then schedules it (UTC). One call replaces a
 * scheduler.ts setTimeout+setInterval pair for a job migrated onto the queue.
 *
 * `singletonKey` refuses an overlapping run (the previous firing still in
 * flight when the next tick arrives) — use it for jobs where a double-run
 * would be unsafe rather than merely redundant (e.g. one that purchases
 * inventory or deletes external resources).
 */
export async function scheduleRecurring(
  name: string,
  cron: string,
  handler: () => Promise<void>,
  options?: { singletonKey?: string },
): Promise<void> {
  const boss = await getBoss();
  await boss.createQueue(name);
  await boss.work(name, async () => {
    await handler();
  });
  await boss.schedule(name, cron, undefined, {
    tz: "UTC",
    ...(options?.singletonKey ? { singletonKey: options.singletonKey } : {}),
  });
}
