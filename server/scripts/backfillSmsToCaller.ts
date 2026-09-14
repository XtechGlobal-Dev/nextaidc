import "dotenv/config";
import { PrismaClient } from "@prisma/client";

// One-shot: seed smsToCallerEnabled from smsEnabled so splitting the column doesn't silently remove the
// feature from plans that had it. Only touches rows still at the default false, so re-runs never undo an admin change.

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
