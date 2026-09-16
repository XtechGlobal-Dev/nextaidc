// pg-boss wrapper (own "pgboss" schema in the main DB, no Redis). Unlike scheduler.ts's setInterval jobs,
// a job here fires on exactly one instance — pg-boss claims via SKIP LOCKED.
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

/** Register a cron job (UTC). `singletonKey` refuses an overlapping run — use it where a double-run
 *  is unsafe (purchases, external deletes), not merely redundant. */
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
