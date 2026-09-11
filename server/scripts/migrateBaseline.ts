import "dotenv/config";
import { readdirSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { PrismaClient } from "@prisma/client";

/* ------------------------------------------------------------------ *
 *  One-time: teach Prisma that the migrations already in this database
 *  are already applied, so `prisma migrate deploy` can take over from
 *  `prisma db push`.
 *
 *  WHY THIS IS NEEDED
 *    This project used to deploy with `prisma db push`, which applies the
 *    schema directly and records nothing. So `_prisma_migrations` is empty even
 *    though every migration's effect is present. Point `migrate deploy` at that
 *    database and it starts from 0001_init, tries `CREATE TABLE "users"`, and
 *    the deploy dies. `render:build` now runs `migrate deploy`, so any database
 *    that was ever synced with `db push` needs this once before its first
 *    deploy. A brand-new empty database does NOT — never run this against one;
 *    it would stamp every migration as applied without running any.
 *
 *    Baselining fixes that by RECORDING migrations as applied without running
 *    them. Nothing in the database changes.
 *
 *  WHY IT MATTERS
 *    `db push --accept-data-loss` cannot see that `call_logs` is partitioned,
 *    so a future schema edit could have it drop and recreate the table, taking
 *    every call with it. `migrate deploy` only ever runs the SQL in
 *    prisma/migrations, and never invents a destructive plan.
 *
 *  HOW TO USE IT
 *      npm run migrate-baseline -- --dry-run   # see what it would mark
 *      npm run migrate-baseline                # mark them
 *
 *    Then switch render:build to `prisma migrate deploy` and deploy.
 *
 *  THE ONE JUDGEMENT CALL
 *    Migrations whose effects are NOT yet in the database must be left
 *    unmarked, so `migrate deploy` actually runs them. This script decides that
 *    by probing for a table each migration creates — see PENDING_PROBES — and
 *    it prints its reasoning for every migration so you can check it before
 *    committing. Read that output. Marking a migration that has not really been
 *    applied means it is skipped forever.
 * ------------------------------------------------------------------ */

const DRY_RUN = process.argv.includes("--dry-run");

/**
 * Migrations identified by an object they create. If the object is absent the
 * migration has not been applied, so it must NOT be baselined.
 *
 * Only the recent ones need entries: everything older predates this work and is
 * certainly present in any database that has been deployed to.
 */
const PENDING_PROBES: Record<
  string,
  { kind: "table" | "column" | "constraint" | "dropped"; name: string; table?: string }
> = {
  "0054_call_archive_and_brand_indexes": { kind: "column", table: "call_logs", name: "blobKey" },
  "0055_partition_call_logs": { kind: "table", name: "call_logs_default" },
  "0056_brand_databases": { kind: "table", name: "brand_databases" },
  // A CHECK constraint: Prisma's own diff can't see it, so this is the only
  // way to know whether the rule is in place.
  "0057_every_account_has_a_brand": {
    kind: "constraint",
    name: "users_brand_required_unless_platform",
  },
  "0058_ticket_escalation": { kind: "column", table: "tickets", name: "escalatedFromId" },
  "0059_tenant_lifecycle": { kind: "table", name: "tenant_database_retirements" },
  "0060_call_shares": { kind: "table", name: "call_shares" },
  "0061_platform_ledger": { kind: "table", name: "platform_ledger" },
  "0062_support_split": { kind: "column", table: "tickets", name: "requesterBrandId" },
  "0063_platform_views": { kind: "table", name: "brand_stats_daily" },
  // The cutover only drops: it is applied once the workspace tables are gone
  // from the control plane (they live in each tenant schema from here on).
  "0064_cutover": { kind: "dropped", name: "profiles" },
};

const prisma = new PrismaClient({
  datasources: { db: { url: process.env.DIRECT_URL || process.env.DATABASE_URL } },
});

// Every probe is pinned to `public`: the tenant schemas (`tenant_<slug>`) carry
// tables of the same names, and a match there says nothing about the control
// plane.
async function tableExists(name: string): Promise<boolean> {
  const rows = await prisma.$queryRaw<{ count: bigint }[]>`
    SELECT count(*) AS count FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relname = ${name}`;
  return Number(rows[0]?.count ?? 0) > 0;
}

async function columnExists(table: string, column: string): Promise<boolean> {
  const rows = await prisma.$queryRaw<{ count: bigint }[]>`
    SELECT count(*) AS count FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = ${table} AND column_name = ${column}`;
  return Number(rows[0]?.count ?? 0) > 0;
}

async function constraintExists(name: string): Promise<boolean> {
  const rows = await prisma.$queryRaw<{ count: bigint }[]>`
    SELECT count(*) AS count FROM pg_constraint WHERE conname = ${name}`;
  return Number(rows[0]?.count ?? 0) > 0;
}

async function alreadyRecorded(): Promise<Set<string>> {
  try {
    const rows = await prisma.$queryRaw<{ migration_name: string }[]>`
      SELECT migration_name FROM "_prisma_migrations" WHERE finished_at IS NOT NULL`;
    return new Set(rows.map((r) => r.migration_name));
  } catch {
    return new Set(); // table absent — a pure db-push database, which is the point
  }
}

const dir = join(process.cwd(), "prisma", "migrations");
const migrations = readdirSync(dir)
  .filter((name) => statSync(join(dir, name)).isDirectory())
  .sort();

// An empty database has nothing to baseline and everything to run: `migrate
// deploy` handles it from 0001_init. Stamping it here would skip every
// migration for good, so refuse before any probe gets a chance to look right.
if (!(await tableExists("users"))) {
  console.error("No `users` table in `public` — this database is empty. Run `prisma migrate deploy` instead.");
  await prisma.$disconnect();
  process.exit(1);
}

const recorded = await alreadyRecorded();
console.log(`${migrations.length} migration(s) on disk, ${recorded.size} already recorded.\n`);

// Migrations are linear: once a later one is in effect, every earlier one was
// run before it. So a probe only has a say up to the newest migration whose
// probe passes — objects an earlier migration created may since have been
// dropped by a later one (the cutover removed `call_logs`, whose column the
// 0054 probe looks for), and that must not read as "never applied".
const verdict = new Map<string, boolean>();
for (const [name, probe] of Object.entries(PENDING_PROBES)) {
  verdict.set(
    name,
    probe.kind === "table"
      ? await tableExists(probe.name)
      : probe.kind === "dropped"
        ? !(await tableExists(probe.name))
        : probe.kind === "constraint"
          ? await constraintExists(probe.name)
          : await columnExists(probe.table!, probe.name),
  );
}
const newestApplied = [...migrations].reverse().find((name) => verdict.get(name) === true);
const newestAppliedAt = newestApplied ? migrations.indexOf(newestApplied) : -1;

const toMark: string[] = [];
for (const [index, name] of migrations.entries()) {
  if (recorded.has(name)) {
    console.log(`  = ${name}  already recorded`);
    continue;
  }
  const probe = PENDING_PROBES[name];
  if (!probe) {
    toMark.push(name);
    console.log(`  ✓ ${name}  predates this work — assumed applied`);
    continue;
  }
  if (index < newestAppliedAt && !verdict.get(name)) {
    toMark.push(name);
    console.log(`  ✓ ${name}  ${probe.kind} "${probe.name}" gone, but ${newestApplied} is in effect — applied`);
    continue;
  }
  const present = verdict.get(name) === true;
  if (present) {
    toMark.push(name);
    console.log(
      `  ✓ ${name}  ${probe.kind} "${probe.name}" ${probe.kind === "dropped" ? "gone" : "exists"} — applied`,
    );
  } else {
    console.log(
      `  ⏳ ${name}  ${probe.kind} "${probe.name}" ${probe.kind === "dropped" ? "still present" : "MISSING"} — left for migrate deploy`,
    );
  }
}

console.log("");
if (toMark.length === 0) {
  console.log("Nothing to baseline.");
} else if (DRY_RUN) {
  console.log(`Dry run: would mark ${toMark.length} migration(s) as applied.`);
} else {
  for (const name of toMark) {
    // `migrate resolve --applied` records the migration WITHOUT running it.
    execFileSync("npx", ["prisma", "migrate", "resolve", "--applied", name], {
      stdio: "inherit",
      // On Windows `npx` is `npx.cmd`, which Node will only run through a shell
      // (spawning it directly is ENOENT, or EINVAL on newer Node). Migration
      // names are [0-9a-z_], so nothing here needs quoting.
      shell: process.platform === "win32",
    });
  }
  console.log(`\nBaselined ${toMark.length} migration(s).`);
  console.log("Next: `npx prisma migrate status` should report up to date; then deploy.");
}

await prisma.$disconnect();
