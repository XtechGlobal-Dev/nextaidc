#!/usr/bin/env node
import { execFileSync } from "node:child_process";

/* ------------------------------------------------------------------ *
 *  Pre-deploy guard: refuse to let `prisma db push` destroy a table it
 *  cannot see the shape of.
 *
 *  `npm run db:sync` runs `prisma db push --accept-data-loss`. Partitioning is
 *  invisible to Prisma's datamodel — it models columns, indexes and
 *  constraints, and has no concept of a table being PARTITION BY RANGE. So if
 *  a schema edit ever makes Prisma decide `call_logs` needs recreating,
 *  `--accept-data-loss` lets it drop a partitioned table and every call in it,
 *  without asking anyone.
 *
 *  This runs the same diff `db push` is about to apply and fails if that diff
 *  would drop or recreate a table we cannot afford to lose. It is a guard, not
 *  a migration: it changes nothing.
 *
 *  Deploys no longer need it: `render:build` runs `prisma migrate deploy`,
 *  which only ever executes the SQL under prisma/migrations and never invents
 *  a destructive plan of its own. Run `npm run schema-drift` by hand before any
 *  `db:sync` against a database whose call history matters.
 * ------------------------------------------------------------------ */

/** Tables whose loss would be unrecoverable, and which are not plain Prisma
 *  tables — so Prisma's diff is not a trustworthy description of them. */
const PROTECTED = ["call_logs", "call_details"];

/**
 * Destructive operations a diff would perform on a protected table.
 *
 * Deliberately narrow: `ALTER TABLE ... ADD COLUMN` on `call_logs` is routine
 * and must not fail the build, or the guard gets switched off within a week.
 * Only DROP TABLE and CREATE TABLE matter — a CREATE means Prisma believes the
 * table is absent, which on a partitioned parent it never is, and is the exact
 * signature of the "recreate it" plan this exists to catch.
 *
 * Exported and pure so it can be tested without a database.
 */
export function dangerousOperations(diff) {
  const found = [];
  for (const raw of diff.split("\n")) {
    const line = raw.trim();
    if (line.startsWith("--") || !line) continue;
    for (const table of PROTECTED) {
      const quoted = new RegExp(`"${table}"`);
      if (!quoted.test(line)) continue;
      if (/^DROP\s+TABLE/i.test(line) || /^CREATE\s+TABLE/i.test(line)) {
        found.push({ table, statement: line });
      }
    }
  }
  return found;
}

/** True when the diff only removes a partition child, which is what the
 *  retention sweep does on purpose and is never Prisma's doing. */
export function isPartitionChild(name) {
  return /_(\d{4})_(\d{2})$/.test(name) || name.endsWith("_default");
}

function main() {
  const url = process.env.DIRECT_URL || process.env.DATABASE_URL;
  if (!url) {
    console.error("schemaDrift: no DIRECT_URL or DATABASE_URL — cannot check. Refusing to pass.");
    process.exit(1);
  }

  let diff;
  try {
    diff = execFileSync(
      "npx",
      [
        "prisma",
        "migrate",
        "diff",
        "--from-url",
        url,
        "--to-schema-datamodel",
        "prisma/schema.prisma",
        "--script",
      ],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
  } catch (e) {
    // A guard that cannot run is not a guard. Fail the build rather than deploy
    // blind — the whole point is that the next step is irreversible.
    console.error("schemaDrift: could not compute the schema diff:", e.message);
    process.exit(1);
  }

  const danger = dangerousOperations(diff);
  if (danger.length === 0) {
    console.log("schemaDrift: no destructive change to protected tables. OK.");
    return;
  }

  console.error("\n🛑 schemaDrift: this deploy would DESTROY a protected table.\n");
  for (const { table, statement } of danger) {
    console.error(`   ${table}: ${statement}`);
  }
  console.error(
    "\n`prisma db push --accept-data-loss` cannot see that call_logs is partitioned, so it\n" +
      "will happily drop and recreate it — taking every call with it.\n\n" +
      "Do NOT bypass this. Apply the change as a hand-written migration that preserves\n" +
      "partitioning, then re-run. See docs/call-log-partitioning.md.\n",
  );
  process.exit(1);
}

// Only run when invoked directly, so the pure helpers above stay importable.
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/").split("/").pop())) {
  main();
}
