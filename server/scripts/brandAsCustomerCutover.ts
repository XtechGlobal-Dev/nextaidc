import "dotenv/config";
import { spawnSync } from "node:child_process";
import { mkdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { prisma } from "../src/prisma.js";
import { EMAIL_TEMPLATE_DEFS, seedEmailTemplates } from "../src/services/emailTemplates.js";

// ONE-TIME production cutover to brand-as-customer (docs/brand-as-customer-plan.md): removes the retired brand
// billing from the database and seeds what the new setup needs. Two stages around the deploy, because the build's
// `prisma db push --accept-data-loss` drops whatever schema.prisma no longer has — the retired tables included —
// so they have to be backed up BEFORE that deploy:
//
//   1. prepare   before deploying; the live version keeps working
//        - lists anything the retired billing still has open in Stripe, and refuses to go on while there is
//        - backs every retired row up to server/backups/brand-as-customer-<time>.json (git-ignored)
//        - adds the new tables/columns and runs their backfills (migrations 0071–0073, idempotent)
//   2. deploy this release; its build drops the retired tables and columns
//   3. finish    after the deploy is live
//        - drops whatever retired is still there (for a database the build didn't push)
//        - re-runs the 0071 backfill for rows created in between
//        - seeds the email templates new in this release (create-only: edited copies are kept)
//        - verifies, and records the cutover as done — it never runs again after that
//
// Every stage only reads unless --apply is given together with --confirm=<database host>:
//
//   npm run cutover:brand-as-customer -- prepare
//   npm run cutover:brand-as-customer -- prepare --apply --confirm=ep-xyz.neon.tech
//   npm run cutover:brand-as-customer -- finish  --apply --confirm=ep-xyz.neon.tech
//
//   --allow-open-billing   go on although Stripe items are still open (you've settled them another way)
//
// Never run `prisma db seed` on production for this: it resets the super admin's password.

type Stage = "prepare" | "finish";
type Row = Record<string, unknown>;

const SERVER_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MIGRATIONS = path.join(SERVER_DIR, "prisma", "migrations");
const BACKUP_DIR = path.join(SERVER_DIR, "backups");

/** New tables, columns and backfills — already in the repo, idempotent. */
const ADDITIVE = ["0071_brand_kind", "0072_brand_admin_requests", "0073_speed_indexes"];

const RETIRED_TABLES = [
  "brand_plans",
  "brand_addon_prices",
  "brand_billing",
  "brand_usage_monthly",
  "brand_plan_addons",
  "brand_wallet_entries",
];
const RETIRED_COLUMNS: Record<string, string[]> = {
  brands: [
    "brandPlanId",
    "addonEditable",
    "maxAddonCents",
    "platformFeeCents",
    "platformFeeCurrency",
    "featurePrices",
    "purchasedFeatures",
    "monthlyMinuteLimit",
    "monthlyAiLimit",
    "serviceHold",
  ],
  brand_requests: ["brandPlanId", "stripeCustomerId", "paymentMethodId", "cardBrand", "cardLast4"],
};

/** The drop, in one transaction. No CASCADE: anything unexpected depending on these fails it loudly.
 *  `platform_ledger` and `brand_settings` stay — both are still in use. */
const DROP_SQL = `
BEGIN;
ALTER TABLE "brands" DROP CONSTRAINT IF EXISTS "brands_brandPlanId_fkey";
ALTER TABLE "brands"
${RETIRED_COLUMNS.brands.map((c) => `  DROP COLUMN IF EXISTS "${c}"`).join(",\n")};
ALTER TABLE "brand_requests"
${RETIRED_COLUMNS.brand_requests.map((c) => `  DROP COLUMN IF EXISTS "${c}"`).join(",\n")};
${["brand_wallet_entries", "brand_plan_addons", "brand_usage_monthly", "brand_billing", "brand_addon_prices", "brand_plans"]
  .map((t) => `DROP TABLE IF EXISTS "${t}";`)
  .join("\n")}
COMMIT;
`;

/** platform_settings keys: the backup prepare took, and the finished cutover (the run-once lock). */
const PREPARED_KEY = "cutover.brand_as_customer.prepared";
const DONE_KEY = "cutover.brand_as_customer.done";

/* --------------------------------- Args ---------------------------------- */

const argv = process.argv.slice(2);
const stage = argv.find((a) => !a.startsWith("--")) as Stage | undefined;
const apply = argv.includes("--apply");
const allowOpenBilling = argv.includes("--allow-open-billing");
const confirm = argv.find((a) => a.startsWith("--confirm="))?.slice("--confirm=".length) ?? "";

const host = (() => {
  try {
    return new URL(process.env.DATABASE_URL ?? "").hostname;
  } catch {
    return "";
  }
})();

/* -------------------------------- Helpers -------------------------------- */

const q = <T = Row>(sql: string, ...params: unknown[]) => prisma.$queryRawUnsafe<T[]>(sql, ...params);

async function count(sql: string, ...params: unknown[]): Promise<number> {
  return (await q<{ n: number }>(sql, ...params))[0]?.n ?? 0;
}

async function tableExists(table: string): Promise<boolean> {
  return (
    (await count(
      `SELECT COUNT(*)::int AS n FROM information_schema.tables WHERE table_schema = current_schema() AND table_name = $1`,
      table,
    )) > 0
  );
}

async function existingColumns(table: string, columns: string[]): Promise<string[]> {
  const rows = await q<{ column_name: string }>(
    `SELECT column_name FROM information_schema.columns
      WHERE table_schema = current_schema() AND table_name = $1 AND column_name = ANY($2::text[])`,
    table,
    columns,
  );
  const found = new Set(rows.map((r) => r.column_name));
  return columns.filter((c) => found.has(c));
}

/** Runs SQL as one script (DO blocks and all) — a migration file, or the drop above. */
function runSql(label: string, opts: { file?: string; sql?: string }): void {
  console.log(`   → ${label}`);
  const res = spawnSync(
    "npx",
    ["prisma", "db", "execute", "--schema", "prisma/schema.prisma", ...(opts.file ? ["--file", opts.file] : ["--stdin"])],
    {
      cwd: SERVER_DIR,
      input: opts.sql,
      stdio: [opts.sql ? "pipe" : "inherit", "inherit", "inherit"],
      shell: process.platform === "win32",
    },
  );
  if (res.status !== 0) throw new Error(`${label} failed (exit ${res.status}) — nothing after it was run.`);
}

const runMigration = (name: string) => runSql(name, { file: path.join(MIGRATIONS, name, "migration.sql") });

async function getSetting(key: string): Promise<string | null> {
  return (await q<{ value: string }>(`SELECT value FROM "platform_settings" WHERE key = $1`, key))[0]?.value ?? null;
}

async function setSetting(key: string, value: unknown): Promise<void> {
  await prisma.platformSetting.upsert({
    where: { key },
    update: { value: JSON.stringify(value) },
    create: { key, value: JSON.stringify(value), isSecret: false },
  });
}

const money = (cents: number, currency: string) => `${(cents / 100).toFixed(2)} ${String(currency).toUpperCase()}`;
const heading = (t: string) => console.log(`\n${t}`);

/* ------------------------------ What's there ----------------------------- */

interface Retired {
  tables: string[];
  columns: Record<string, string[]>;
}

async function retiredLeft(): Promise<Retired> {
  const tables: string[] = [];
  for (const t of RETIRED_TABLES) if (await tableExists(t)) tables.push(t);
  const columns: Record<string, string[]> = {};
  for (const [table, cols] of Object.entries(RETIRED_COLUMNS)) {
    const left = await existingColumns(table, cols);
    if (left.length) columns[table] = left;
  }
  return { tables, columns };
}

const nothingRetired = (r: Retired) => !r.tables.length && !Object.keys(r.columns).length;

async function describeRetired(r: Retired): Promise<void> {
  if (nothingRetired(r)) return void console.log("   none — already dropped");
  for (const t of r.tables) console.log(`   table   ${t}: ${await count(`SELECT COUNT(*)::int AS n FROM "${t}"`)} rows`);
  for (const [table, cols] of Object.entries(r.columns)) console.log(`   columns ${table}: ${cols.join(", ")}`);
}

/** What the retired billing still has open. Nothing reads these tables afterwards, so each must be settled by hand. */
async function openBilling(r: Retired): Promise<string[]> {
  const names = new Map(
    (await q<{ id: string; name: string; slug: string }>(`SELECT id, name, slug FROM "brands"`)).map((b) => [
      b.id,
      `${b.name} (${b.slug})`,
    ]),
  );
  const label = (id: string) => names.get(id) ?? id;
  const open: string[] = [];
  if (r.tables.includes("brand_billing")) {
    for (const s of await q<{ brandId: string; stripeSubscriptionId: string; status: string }>(
      `SELECT "brandId", "stripeSubscriptionId", status FROM "brand_billing"
        WHERE "stripeSubscriptionId" IS NOT NULL AND status <> 'canceled'`,
    )) {
      open.push(`brand subscription still live: ${label(s.brandId)} — ${s.stripeSubscriptionId} (${s.status}); cancel it in Stripe`);
    }
  }
  if (r.tables.includes("brand_wallet_entries")) {
    for (const w of await q<{ brandId: string; currency: string; cents: number }>(
      `SELECT "brandId", currency, SUM("amountCents")::int AS cents FROM "brand_wallet_entries"
        GROUP BY "brandId", currency HAVING SUM("amountCents") <> 0`,
    )) {
      open.push(`wallet balance not paid out: ${label(w.brandId)} — ${money(w.cents, w.currency)}`);
    }
  }
  if (r.tables.includes("brand_plan_addons")) {
    for (const p of await q<{ brandId: string; stripePriceId: string; plan: string; planPrice: string | null }>(
      `SELECT a."brandId", a."stripePriceId", p."displayName" AS plan, p."stripePriceId" AS "planPrice"
         FROM "brand_plan_addons" a JOIN "subscription_plans" p ON p.id = a."planId"
        WHERE a."addonCents" > 0 AND a."stripePriceId" <> ''`,
    )) {
      open.push(
        `marked-up Stripe Price: ${label(p.brandId)} · ${p.plan} — ${p.stripePriceId}; move its subscribers to ${
          p.planPrice ?? "the plan's own Price"
        }, then archive it`,
      );
    }
  }
  if (r.columns.brand_requests?.includes("stripeCustomerId")) {
    for (const c of await q<{ brandName: string; stripeCustomerId: string; status: string }>(
      `SELECT "brandName", "stripeCustomerId", status FROM "brand_requests" WHERE "stripeCustomerId" <> ''`,
    )) {
      open.push(`saved card on a brand request: "${c.brandName}" (${c.status}) — delete Stripe customer ${c.stripeCustomerId}`);
    }
  }
  return open;
}

/** Every retired row, and each retired column with its row's id — enough to put any of it back by hand. */
async function backup(r: Retired): Promise<{ file: string; rows: number }> {
  const createdAt = new Date().toISOString();
  const data = { createdAt, host, tables: {} as Record<string, Row[]>, columns: {} as Record<string, Row[]> };
  let rows = 0;
  for (const t of r.tables) {
    data.tables[t] = await q(`SELECT * FROM "${t}"`);
    rows += data.tables[t].length;
  }
  for (const [table, cols] of Object.entries(r.columns)) {
    data.columns[table] = await q(`SELECT id, ${cols.map((c) => `"${c}"`).join(", ")} FROM "${table}"`);
    rows += data.columns[table].length;
  }
  mkdirSync(BACKUP_DIR, { recursive: true });
  const file = path.join(BACKUP_DIR, `brand-as-customer-${createdAt.replace(/[:.]/g, "-")}.json`);
  writeFileSync(file, JSON.stringify(data, (_k, v) => (typeof v === "bigint" ? Number(v) : v), 2));
  if (!statSync(file).size) throw new Error(`Backup ${file} is empty — stopping before anything is changed.`);
  return { file, rows };
}

/** Rows the 0071 backfill would still fill in; null while its columns don't exist yet. */
async function backfillPending(): Promise<{ brandSince: number; activatedAt: number; owner: number } | null> {
  if ((await existingColumns("brands", ["kind", "ownerUserId", "brandSince", "activatedAt"])).length < 4) return null;
  return {
    brandSince: await count(`SELECT COUNT(*)::int AS n FROM "brands" WHERE kind = 'brand' AND "brandSince" IS NULL`),
    activatedAt: await count(`SELECT COUNT(*)::int AS n FROM "brands" WHERE kind = 'brand' AND "activatedAt" IS NULL`),
    owner: await count(
      `SELECT COUNT(*)::int AS n FROM "brands" b WHERE b."ownerUserId" IS NULL
          AND EXISTS (SELECT 1 FROM "customer_directory" d WHERE d."brandId" = b.id AND d.role = 'ADMIN')`,
    ),
  };
}

/* --------------------------------- Stages -------------------------------- */

async function prepare(): Promise<void> {
  const retired = await retiredLeft();

  heading("1. Retired brand billing still in the database");
  await describeRetired(retired);

  heading("2. Open in Stripe — settle these before the retired tables go");
  const open = await openBilling(retired);
  for (const o of open) console.log(`   - ${o}`);
  if (!open.length) console.log("   nothing open");

  heading("3. New tables and columns (0071–0073)");
  const wantBrands = ["kind", "ownerUserId", "activatedAt", "brandSince", "downgradedAt", "poolSpare"];
  const wantRequests = ["applicantBrandId", "applicantUserId"];
  const haveBrands = await existingColumns("brands", wantBrands);
  const haveRequests = await existingColumns("brand_requests", wantRequests);
  const missing = [
    ...wantBrands.filter((c) => !haveBrands.includes(c)).map((c) => `brands.${c}`),
    ...wantRequests.filter((c) => !haveRequests.includes(c)).map((c) => `brand_requests.${c}`),
    ...((await tableExists("coupon_holds")) ? [] : ["coupon_holds"]),
  ];
  console.log(missing.length ? `   to add: ${missing.join(", ")}` : "   all present");
  const pending = await backfillPending();
  console.log(
    pending
      ? `   backfill: ${pending.brandSince} brandSince, ${pending.activatedAt} activatedAt, ${pending.owner} owners`
      : "   backfill: runs right after the columns are added",
  );

  if (!apply) return dryRunFooter("prepare");
  if (open.length && !allowOpenBilling) {
    throw new Error("Stripe items above are still open. Settle them (or pass --allow-open-billing) and run again. Nothing was changed.");
  }

  heading("Applying");
  if (!nothingRetired(retired)) {
    const { file, rows } = await backup(retired);
    console.log(`   ✓ backed up ${rows} rows → ${file}`);
    await setSetting(PREPARED_KEY, { at: new Date().toISOString(), host, file: path.basename(file), rows });
  } else {
    console.log("   retired data already gone — no backup needed");
  }
  for (const m of ADDITIVE) runMigration(m);
  console.log("   ✓ new tables, columns and backfills in place");
  console.log("\nNext: deploy this release, then run `finish`.");
}

async function finish(): Promise<void> {
  const done = await getSetting(DONE_KEY);
  if (done) {
    console.log(`\nAlready finished (${done}) — this cutover runs only once. Nothing to do.`);
    return;
  }
  const retired = await retiredLeft();
  const prepared = await getSetting(PREPARED_KEY);

  heading("1. Retired brand billing still in the database (dropped now)");
  await describeRetired(retired);
  if (!nothingRetired(retired)) console.log(prepared ? `   backup on record: ${prepared}` : "   ⚠ no backup on record yet");

  heading("2. Backfill (0071) for rows created since prepare");
  const pending = await backfillPending();
  if (!pending) throw new Error("brands.kind / ownerUserId are missing — run `prepare --apply` (or deploy) first.");
  console.log(`   ${pending.brandSince} brandSince, ${pending.activatedAt} activatedAt, ${pending.owner} owners`);

  heading("3. Email templates new in this release (create-only)");
  const have = new Set((await q<{ key: string }>(`SELECT key FROM "email_templates"`)).map((r) => r.key));
  const newTemplates = EMAIL_TEMPLATE_DEFS.map((d) => d.key).filter((k) => !have.has(k));
  console.log(newTemplates.length ? `   to add: ${newTemplates.join(", ")}` : "   all present");

  if (!apply) {
    if (!nothingRetired(retired)) console.log(`\nThe drop that --apply runs:${DROP_SQL}`);
    return dryRunFooter("finish");
  }
  if (!nothingRetired(retired) && !prepared) {
    throw new Error("Retired data is still here but was never backed up — run `prepare --apply` first. Nothing was changed.");
  }

  heading("Applying");
  runMigration(ADDITIVE[0]);
  console.log("   ✓ backfill");
  if (!nothingRetired(retired)) {
    runSql("drop retired brand billing", { sql: DROP_SQL });
    console.log("   ✓ retired tables and columns dropped");
  }
  await seedEmailTemplates();
  console.log("   ✓ email templates seeded");

  heading("Verify");
  const after = await retiredLeft();
  if (!nothingRetired(after)) throw new Error(`Retired items are still present: ${JSON.stringify(after)}`);
  const kinds = await q<{ kind: string; n: number }>(`SELECT kind::text AS kind, COUNT(*)::int AS n FROM "brands" GROUP BY kind`);
  console.log(`   brands: ${kinds.map((k) => `${k.n} ${k.kind}`).join(", ") || "none"}`);
  const ownerless = await q<{ name: string; slug: string }>(
    `SELECT name, slug FROM "brands" WHERE kind = 'brand' AND "ownerUserId" IS NULL ORDER BY name`,
  );
  if (ownerless.length) {
    console.log(`   ⚠ ${ownerless.length} brand(s) have no admin to own them (they can't be downgraded until one is added):`);
    for (const b of ownerless) console.log(`     - ${b.name} (${b.slug})`);
  }
  const spares = await count(`SELECT COUNT(*)::int AS n FROM "brands" WHERE "poolSpare" = true AND status = 'active'`);
  console.log(`   customer database spares ready: ${spares} (the app tops this up every 10 minutes)`);

  await setSetting(DONE_KEY, { at: new Date().toISOString(), host });
  console.log("\n✓ Brand-as-customer cutover finished. It won't run again.");
}

function dryRunFooter(s: Stage): void {
  console.log(
    `\nDry run — nothing was changed. To apply:\n  npm run cutover:brand-as-customer -- ${s} --apply --confirm=${host || "<database host>"}`,
  );
}

/* ---------------------------------- Main --------------------------------- */

try {
  if (stage !== "prepare" && stage !== "finish") {
    throw new Error("Say which stage: `prepare` (before deploying) or `finish` (after). See the top of this file.");
  }
  if (!host) throw new Error("DATABASE_URL is not set (or isn't a URL).");
  console.log(`Brand-as-customer cutover — ${stage}${apply ? " (APPLY)" : " (dry run)"} on ${host}`);
  if (apply && confirm !== host) {
    throw new Error(`--apply needs --confirm=${host}, so it can't run against the wrong database by accident.`);
  }
  await (stage === "prepare" ? prepare() : finish());
} catch (e) {
  console.error(`\n✗ ${e instanceof Error ? e.message : String(e)}`);
  process.exitCode = 1;
} finally {
  await prisma.$disconnect();
}
