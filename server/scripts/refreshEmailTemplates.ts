import "dotenv/config";
import { prisma } from "../src/prisma.js";
import { EMAIL_TEMPLATE_DEFS, GLOBAL_VARS } from "../src/services/emailTemplates.js";

// Force listed email templates back to code defaults (the boot seeder never overwrites, so code changes
// don't reach seeded rows). Keys from CLI args or DEFAULT_KEYS; `enabled` is preserved.

const DEFAULT_KEYS = ["staff_permissions_updated", "staff_role_permissions_updated"];
const keys = process.argv.slice(2).length ? process.argv.slice(2) : DEFAULT_KEYS;

try {
  let refreshed = 0;
  for (const key of keys) {
    const d = EMAIL_TEMPLATE_DEFS.find((t) => t.key === key);
    if (!d) {
      console.warn(`⚠  Unknown template key "${key}" — skipped.`);
      continue;
    }
    const variables = [...GLOBAL_VARS, ...d.variables];
    await prisma.emailTemplate.upsert({
      where: { key: d.key },
      // Overwrite the editable copy back to the code default. `enabled` is left
      // out so the current on/off state is kept.
      update: {
        subject: d.subject,
        body: d.body,
        variables,
        category: d.category,
        name: d.name,
        description: d.description,
        audience: d.audience,
        alwaysOn: d.alwaysOn,
      },
      create: {
        key: d.key,
        category: d.category,
        name: d.name,
        description: d.description,
        audience: d.audience,
        subject: d.subject,
        body: d.body,
        variables,
        alwaysOn: d.alwaysOn,
      },
    });
    console.log(`✓ Refreshed "${d.key}"`);
    refreshed += 1;
  }
  console.log(`\nDone — refreshed ${refreshed} template(s) to code defaults.`);
} finally {
  await prisma.$disconnect();
}
