import "dotenv/config";
import { readdirSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { PrismaClient } from "@prisma/client";

// One-time baseline for a `db push` DB: records migrations as applied so `migrate deploy` can take over. NEVER run
// against an empty DB, and read the `--dry-run` verdicts — a wrongly marked migration is skipped forever.

const DRY_RUN = process.argv.includes("--dry-run");

// Probe objects per migration: absent → not applied → must NOT be baselined. Older migrations need no entry.
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

// Pinned to `public`: tenant schemas carry same-named tables and say nothing about the control plane.
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

// Refuse an empty DB before any probe can look right — stamping it would skip every migration for good.
if (!(await tableExists("users"))) {
  console.error("No `users` table in `public` — this database is empty. Run `prisma migrate deploy` instead.");
  await prisma.$disconnect();
  process.exit(1);
}

const recorded = await alreadyRecorded();
console.log(`${migrations.length} migration(s) on disk, ${recorded.size} already recorded.\n`);

// Migrations are linear, so anything before the newest passing probe counts as applied — a later
// migration may have dropped an earlier one's object (the cutover removed `call_logs`).
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
      // Windows `npx.cmd` only runs through a shell (ENOENT/EINVAL otherwise); names are [0-9a-z_], no quoting needed.
      shell: process.platform === "win32",
    });
  }
  console.log(`\nBaselined ${toMark.length} migration(s).`);
  console.log("Next: `npx prisma migrate status` should report up to date; then deploy.");
}

await prisma.$disconnect();
