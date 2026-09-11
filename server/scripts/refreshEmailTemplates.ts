import "dotenv/config";
import { prisma } from "../src/prisma.js";
import { EMAIL_TEMPLATE_DEFS, GLOBAL_VARS } from "../src/services/emailTemplates.js";

/* ------------------------------------------------------------------ *
 *  One-time: force the stored email templates back to the code
 *  defaults for a targeted set of keys (subject + body + variables +
 *  metadata).
 *
 *  Why this exists: the boot seeder (`seedEmailTemplates`) never
 *  overwrites an existing subject/body so an admin's edits are
 *  preserved — which also means a change to a default body in code
 *  won't reach an already-seeded row. This script DELIBERATELY
 *  overwrites subject/body/variables, but only for the keys listed
 *  below (or passed as CLI args), so unrelated admin customisations
 *  stay untouched. The on/off (`enabled`) state is preserved.
 *
 *  Usage:
 *    npm run refresh-email-templates                       # staff perm emails
 *    npm run refresh-email-templates -- staff_welcome ...  # specific keys
 *
 *  Idempotent — safe to run more than once.
 * ------------------------------------------------------------------ */

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
