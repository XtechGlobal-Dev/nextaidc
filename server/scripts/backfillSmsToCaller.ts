import "dotenv/config";
import { PrismaClient } from "@prisma/client";

/* ------------------------------------------------------------------ *
 *  One-shot: seed smsToCallerEnabled from smsEnabled.
 *
 *  "SMS to Caller" used to ride on the smsEnabled flag. Splitting it into
 *  its own column defaults every existing plan to false, which would
 *  silently take the feature away from plans that already had it. Copying
 *  the old flag across keeps every plan exactly as it was; from then on the
 *  two are edited independently in Admin → Plans.
 *
 *  Safe to re-run: only touches plans where the two still disagree AND the
 *  new flag is still at its default false, so it never undoes an admin's
 *  later deliberate change.
 * ------------------------------------------------------------------ */

const prisma = new PrismaClient();
const APPLY = process.argv.includes("--apply");

async function main() {
  const plans = await prisma.subscriptionPlan.findMany({
    select: { id: true, name: true, displayName: true, smsEnabled: true, smsToCallerEnabled: true },
    orderBy: { name: "asc" },
  });

  const toFix = plans.filter((p) => p.smsEnabled && !p.smsToCallerEnabled);
  console.log(`plans: ${plans.length} | need backfill: ${toFix.length}\n`);
  for (const p of plans) {
    const mark = toFix.includes(p) ? "->  will enable" : "    unchanged  ";
    console.log(`  ${mark}  ${p.displayName || p.name}  (sms=${p.smsEnabled}, smsToCaller=${p.smsToCallerEnabled})`);
  }

  if (!toFix.length) return console.log("\nNothing to do.");
  if (!APPLY) return console.log("\nDry run. Re-run with --apply to write.");

  const { count } = await prisma.subscriptionPlan.updateMany({
    where: { id: { in: toFix.map((p) => p.id) } },
    data: { smsToCallerEnabled: true },
  });
  console.log(`\nUpdated ${count} plan(s).`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
