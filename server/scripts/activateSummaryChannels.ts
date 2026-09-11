import "dotenv/config";

/* ------------------------------------------------------------------ *
 *  One-time backfill: turn the owner call-summary channels ON for
 *  existing accounts.
 *
 *  Background: summary channels are now on-by-default, but accounts
 *  created before that change have these toggles stored as `false`
 *  (the old default). Since the post-call dispatch now gates on the
 *  toggles, those users would silently stop receiving summaries. This
 *  flips ownerEmailSummary / ownerSmsSummary / ownerWhatsAppSummary to
 *  true once. It does NOT touch override destinations, client toggles,
 *  or any other config. Idempotent — safe to run more than once.
 * ------------------------------------------------------------------ */
// A brand's workspace lives in the brand's database (phase 6): BRAND=<slug> picks it.
import { prisma } from "./_brandDb.js";

type Automations = Record<string, unknown>;

try {
  const rows = await prisma.conversion.findMany({ select: { id: true, agentConfig: true } });
  let updated = 0;

  for (const row of rows) {
    const config = (row.agentConfig ?? {}) as { automations?: Automations };
    const a = config.automations ?? {};
    const alreadyOn =
      a.ownerEmailSummary === true && a.ownerSmsSummary === true && a.ownerWhatsAppSummary === true;
    if (alreadyOn) continue;

    const nextConfig = {
      ...config,
      automations: {
        ...a,
        ownerEmailSummary: true,
        ownerSmsSummary: true,
        ownerWhatsAppSummary: true,
      },
    };
    await prisma.conversion.update({
      where: { id: row.id },
      data: { agentConfig: nextConfig as object },
    });
    updated += 1;
  }

  console.log(`Activated summary channels on ${updated} of ${rows.length} account(s).`);
} finally {
  await prisma.$disconnect();
}
