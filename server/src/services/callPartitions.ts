import { Prisma, type PrismaClient } from "@prisma/client";
import { prisma } from "../prisma.js";
import { env } from "../env.js";

// Structural so the tenant client fits: a sweep hardwired to `prisma` would quietly skip every brand's partitions.
type CallDb = Pick<PrismaClient, "$queryRaw" | "$queryRawUnsafe" | "$executeRaw" | "$executeRawUnsafe">;

// Monthly call_logs partitions: provision ahead (else calls land in call_logs_default) and drop whole months past retention;
// straddling months go to callArchive's row prune. Interpolated identifiers come only from a computed year/month — Postgres can't bind table names.

/** Months of empty partitions to keep ahead of today. Two is enough that a
 *  sweep can fail for a month before anything reaches the default partition. */
const MONTHS_AHEAD = 2;

/** The partitioned table this maintains: `call_logs`, in the control plane and
 *  in every brand's own database alike. */
export type PartitionedTable = "call_logs";

/** Partition naming: call_logs_2026_09. Sortable, and obvious in \dt output. */
function partitionName(table: PartitionedTable, year: number, month: number): string {
  return `${table}_${year}_${String(month).padStart(2, "0")}`;
}

/** First instant of a month, UTC. Partition bounds are half-open: [from, to). */
function monthStart(year: number, month: number): Date {
  return new Date(Date.UTC(year, month - 1, 1));
}

/** `n` months after the given month, normalised across year boundaries. */
function addMonths(year: number, month: number, n: number): { year: number; month: number } {
  const zero = year * 12 + (month - 1) + n;
  return { year: Math.floor(zero / 12), month: (zero % 12) + 1 };
}

function ymd(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export interface PartitionSweepResult {
  /** Partitions created this run. */
  created: string[];
  /** Partitions dropped as wholly past the retention window. */
  dropped: string[];
  /** Rows sitting in the catch-all partition — should always be 0. */
  defaultRows: number;
}

/** Creates missing partitions through MONTHS_AHEAD, then drops whole months past retention. Idempotent — racing instances both succeed. */
export async function sweepCallPartitions(
  retentionDays = env.CALL_RETENTION_DAYS,
  now = new Date(),
  db: CallDb = prisma,
  table: PartitionedTable = "call_logs",
): Promise<PartitionSweepResult> {
  const result: PartitionSweepResult = { created: [], dropped: [], defaultRows: 0 };
  if (!(await isPartitioned(db, table))) return result;

  // --- provision forward -------------------------------------------------
  const base = { year: now.getUTCFullYear(), month: now.getUTCMonth() + 1 };
  for (let i = 0; i <= MONTHS_AHEAD; i++) {
    const { year, month } = addMonths(base.year, base.month, i);
    const next = addMonths(year, month, 1);
    const name = partitionName(table, year, month);
    const created = await createPartition(
      db,
      table,
      name,
      ymd(monthStart(year, month)),
      ymd(monthStart(next.year, next.month)),
    );
    if (created) result.created.push(name);
  }

  // --- reclaim behind ----------------------------------------------------
  if (retentionDays > 0) {
    const cutoff = new Date(now.getTime() - retentionDays * 86_400_000);
    for (const name of await listMonthPartitions(db, table)) {
      const bounds = parsePartitionMonth(table, name);
      if (!bounds) continue;
      const end = monthStart(
        addMonths(bounds.year, bounds.month, 1).year,
        addMonths(bounds.year, bounds.month, 1).month,
      );
      // Only when the whole month is past the cutoff; a straddling partition holds calls the operator asked to keep.
      if (end.getTime() > cutoff.getTime()) continue;
      await dropPartition(db, table, name);
      result.dropped.push(name);
    }
  }

  result.defaultRows = await countDefaultRows(db, table);
  return result;
}

/* ---------------------------- Primitives --------------------------- */

// Every catalogue lookup is scoped to current_schema(): a local-schema tenant shares the cluster with
// the control plane, so an unscoped lookup would find public.call_logs_2026_09 and leave the tenant's calls in its catch-all.

/** True when call_logs is actually partitioned — so this is a no-op on a
 *  deployment that hasn't run migration 0055 yet. */
export async function isPartitioned(
  db: CallDb = prisma,
  table: PartitionedTable = "call_logs",
): Promise<boolean> {
  const rows = await db.$queryRaw<{ count: bigint }[]>`
    SELECT count(*) AS count FROM pg_partitioned_table pt
    JOIN pg_class c     ON c.oid = pt.partrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relname = ${table} AND n.nspname = current_schema()`;
  return Number(rows[0]?.count ?? 0) > 0;
}

/** Create one monthly partition. Returns false when it already existed. */
async function createPartition(
  db: CallDb,
  table: PartitionedTable,
  name: string,
  from: string,
  to: string,
): Promise<boolean> {
  const existed = await partitionExists(db, name);
  if (existed) return false;
  // Identifiers cannot be bound, so they are interpolated — but every value
  // here is derived from a computed date, never from a request.
  await db.$executeRawUnsafe(
    `CREATE TABLE IF NOT EXISTS "${name}" PARTITION OF "${table}"
       FOR VALUES FROM ('${from}') TO ('${to}')`,
  );
  return true;
}

async function dropPartition(db: CallDb, table: PartitionedTable, name: string): Promise<void> {
  // DETACH first so the drop doesn't block behind readers of the parent, and a mistake is briefly recoverable.
  await db.$executeRawUnsafe(`ALTER TABLE "${table}" DETACH PARTITION "${name}"`);
  await db.$executeRawUnsafe(`DROP TABLE "${name}"`);
}

async function partitionExists(db: CallDb, name: string): Promise<boolean> {
  const rows = await db.$queryRaw<{ count: bigint }[]>`
    SELECT count(*) AS count FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relname = ${name} AND n.nspname = current_schema()`;
  return Number(rows[0]?.count ?? 0) > 0;
}

/** Every attached monthly partition, oldest first. Excludes the default. */
async function listMonthPartitions(db: CallDb, table: PartitionedTable): Promise<string[]> {
  const rows = await db.$queryRaw<{ relname: string }[]>`
    SELECT c.relname FROM pg_inherits i
    JOIN pg_class c      ON c.oid = i.inhrelid
    JOIN pg_class parent ON parent.oid = i.inhparent
    JOIN pg_namespace n  ON n.oid = parent.relnamespace
    WHERE parent.relname = ${table}
      AND n.nspname = current_schema()
      AND c.relname ~ ('^' || ${table} || '_[0-9]{4}_[0-9]{2}$')
    ORDER BY c.relname`;
  return rows.map((r) => r.relname);
}

function parsePartitionMonth(
  table: PartitionedTable,
  name: string,
): { year: number; month: number } | null {
  // `\\d` — inside a template literal a single backslash would be eaten by the
  // string, leaving the regex matching a literal "d".
  const m = new RegExp(`^${table}_(\\d{4})_(\\d{2})$`).exec(name);
  if (!m) return null;
  return { year: Number(m[1]), month: Number(m[2]) };
}

/** Rows in the catch-all partition. Always 0 when healthy; anything else means the sweep lapsed and those calls will never be pruned or dropped. */
export async function countDefaultRows(
  db: CallDb = prisma,
  table: PartitionedTable = "call_logs",
): Promise<number> {
  try {
    const rows = await db.$queryRawUnsafe<{ count: bigint }[]>(
      `SELECT count(*) AS count FROM "${table}_default"`,
    );
    return Number(rows[0]?.count ?? 0);
  } catch {
    return 0; // no default partition on an unpartitioned deployment
  }
}

/** Moves catch-all rows into their proper months (once after migration 0055, and as repair after a lapsed sweep). Re-inserting is the only way to re-route in Postgres. */
export async function repartitionDefaultRows(batch = 1000, db: CallDb = prisma): Promise<number> {
  if (!(await isPartitioned(db, "call_logs"))) return 0;
  let moved = 0;

  for (;;) {
    // Provision whatever months the stranded rows actually need before moving
    // them, or the re-insert would route them straight back to the default.
    const months = await db.$queryRaw<{ y: number; m: number }[]>`
      SELECT DISTINCT EXTRACT(YEAR  FROM "createdAt")::int AS y,
                      EXTRACT(MONTH FROM "createdAt")::int AS m
      FROM "call_logs_default" LIMIT 240`;
    if (months.length === 0) return moved;

    for (const { y, m } of months) {
      const next = addMonths(y, m, 1);
      await createPartition(
        db,
        "call_logs",
        partitionName("call_logs", y, m),
        ymd(monthStart(y, m)),
        ymd(monthStart(next.year, next.month)),
      );
    }

    // DELETE ... RETURNING feeding an INSERT, in one statement so a crash
    // mid-move cannot leave a call in neither place.
    const affected = await db.$executeRaw`
      WITH moved AS (
        DELETE FROM "call_logs_default"
        WHERE ctid IN (SELECT ctid FROM "call_logs_default" LIMIT ${Prisma.raw(String(batch))})
        RETURNING *
      )
      INSERT INTO "call_logs" SELECT * FROM moved`;
    if (affected === 0) return moved;
    moved += affected;
  }
}
