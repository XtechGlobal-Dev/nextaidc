import "dotenv/config";

// One-time: cf_phone reworded to "don't ask", cf_date/cf_suburb removed. Only exact old-default labels are touched; idempotent.
// A brand's workspace lives in the brand's database (phase 6): BRAND=<slug> picks it.
import { prisma } from "./_brandDb.js";

type CaptureField = { id: string; label: string; enabled: boolean };

const OLD_PHONE_LABEL = "Confirm best contact number";
const NEW_PHONE_LABEL =
  "Do not ask for the contact number. Automatically use the caller's phone number as the contact number unless they provide a different one.";

function migrate(fields: CaptureField[]): { fields: CaptureField[]; changed: boolean } {
  let changed = false;
  const next = fields.flatMap((f) => {
    if (f.id === "cf_phone" && f.label === OLD_PHONE_LABEL) {
      changed = true;
      return [{ ...f, label: NEW_PHONE_LABEL }];
    }
    if (f.id === "cf_date" && f.label === "Preferred job date") {
      changed = true;
      return [];
    }
    if (f.id === "cf_suburb" && f.label === "Suburb / location") {
      changed = true;
      return [];
    }
    return [f];
  });
  return { fields: next, changed };
}

try {
  const rows = await prisma.conversion.findMany({
    select: { id: true, agentConfig: true, dataCaptureFields: true },
  });
  let updated = 0;

  for (const row of rows) {
    const config = (row.agentConfig ?? {}) as { knowledge?: { captureFields?: CaptureField[] } };
    const configFields = config.knowledge?.captureFields;
    const columnFields = row.dataCaptureFields as CaptureField[] | null;

    const configResult = Array.isArray(configFields) ? migrate(configFields) : null;
    const columnResult = Array.isArray(columnFields) ? migrate(columnFields) : null;
    if (!configResult?.changed && !columnResult?.changed) continue;

    await prisma.conversion.update({
      where: { id: row.id },
      data: {
        ...(configResult?.changed && {
          agentConfig: {
            ...config,
            knowledge: { ...config.knowledge, captureFields: configResult.fields },
          } as object,
        }),
        ...(columnResult?.changed && { dataCaptureFields: columnResult.fields as object }),
      },
    });
    updated += 1;
  }

  console.log(`Migrated capture fields on ${updated} of ${rows.length} account(s).`);
} finally {
  await prisma.$disconnect();
}
