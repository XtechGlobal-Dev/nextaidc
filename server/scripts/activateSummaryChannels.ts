import "dotenv/config";

// One-time: flip owner summary toggles ON for old accounts, which would otherwise silently stop getting summaries. Idempotent.
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
