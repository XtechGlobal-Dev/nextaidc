import { Prisma, type PrismaClient } from "@prisma/client";
import { prisma } from "../prisma.js";
import { env } from "../env.js";

/** Any database holding call logs — the control plane while its old table
 *  empties out, and every brand's own database. Structural, so the tenant
 *  client fits too: a brand's partitions need maintaining exactly as much as
 *  this one's, and a sweep hardwired to `prisma` would quietly stop doing it. */
type CallDb = Pick<PrismaClient, "$queryRaw" | "$queryRawUnsafe" | "$executeRaw" | "$executeRawUnsafe">;

/* ------------------------------------------------------------------ *
 *  Monthly partition maintenance for `call_logs`.
 *
 *  A range-partitioned table is only as good as the partitions that exist.
 *  Nothing creates next month automatically, so this runs daily and keeps a
 *  buffer of future months provisioned. Miss that and every new call lands in
 *  `call_logs_default` — which still works, but quietly undoes the point of
 *  partitioning, so `defaultRows` is reported and warned about.
 *
 *  Retention is the other half. Dropping a partition returns its disk in one
 *  catalogue update, where the equivalent DELETE would rewrite pages and leave
 *  autovacuum grinding for hours. That only applies to whole months that are
 *  entirely past the window — a partition straddling the cutoff is left to the
 *  row-by-row prune in callArchive.ts, because dropping it would take calls the
 *  operator still wanted.
 *
 *  Every identifier here is built from a computed year/month, never from user
 *  input — Postgres has no bind parameters for table names, so these have to be
 *  interpolated and the only safe interpolation is one that can't be influenced.
 * ------------------------------------------------------------------ */

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

/**
 * Create any missing partition for the current month and the next
 * MONTHS_AHEAD, then drop whole months that are entirely past retention.
 *
 * Idempotent: `IF NOT EXISTS` means two instances racing both succeed, and a
 * month that already exists costs one catalogue lookup.
 */
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
      // Strictly past the cutoff: the newest row this partition could hold is
      // still older than the window. A partition straddling the cutoff holds
      // calls the operator asked to keep, so it is left to the row-wise prune.
      if (end.getTime() > cutoff.getTime()) continue;
      await dropPartition(db, table, name);
      result.dropped.push(name);
    }
  }

  result.defaultRows = await countDefaultRows(db, table);
  return result;
}

/* ---------------------------- Primitives --------------------------- */

/* Every catalogue lookup below is scoped to `current_schema()`. A tenant on
 * the `local-schema` provider is a schema on the SAME cluster as the control
 * plane, whose own `call_logs_2026_09` sits in `public` — an unscoped lookup
 * by name would find that one, decide the tenant's month already exists, and
 * quietly leave every call of the tenant's in its catch-all partition. The
 * tenant's connection string sets search_path, so current_schema() is the
 * tenant's schema there and `public` everywhere else. */

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
  // DETACH first so the drop never blocks behind a query still reading the
  // parent, and so a mistake leaves the data recoverable for a moment rather
  // than gone the instant the statement lands.
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

/**
 * Rows that fell into the catch-all partition.
 *
 * Always zero in a healthy system. Anything else means the sweep stopped
 * running long enough for reality to outrun the provisioned months, and those
 * calls are now sitting in a partition that will never be pruned or dropped.
 */
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

/**
 * Move rows out of the catch-all partition into their proper months.
 *
 * Needed once after migration 0055 (the copy lands everything in the default,
 * because the monthly partitions don't exist yet), and as the repair when a
 * lapsed sweep let calls accumulate there. Re-inserting is what triggers
 * routing; there is no in-place "re-route" in Postgres.
 */
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
