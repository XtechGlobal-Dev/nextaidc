import "dotenv/config";
// A brand's workspace lives in the brand's database (phase 6): BRAND=<slug> picks it.
import { prisma } from "./_brandDb.js";
import { loadSettings, integrationsStatus } from "../src/services/settings.js";
import { getCustomerCardFingerprint } from "../src/services/stripe.js";

// One-off: store Stripe card fingerprints for pre-dedup accounts so one card can't open a second trial.
// Run: npm run backfill-cards

await loadSettings(); // hydrate Stripe key from DB/env so the client works

if (!integrationsStatus().stripe) {
  console.error("Stripe is not configured — set the secret key in Admin → Settings or server/.env.");
  process.exit(1);
}

const profiles = await prisma.profile.findMany({
  where: { stripeCustomerId: { not: null }, cardFingerprint: null },
  select: { userId: true, stripeCustomerId: true },
});

console.log(`Backfilling card fingerprints for ${profiles.length} account(s)…`);

let set = 0;
let skipped = 0;
for (const p of profiles) {
  try {
    const fp = await getCustomerCardFingerprint(p.stripeCustomerId!);
    if (!fp) {
      console.log(`- ${p.userId}: no card on file, skipping`);
      skipped++;
      continue;
    }
    // If another account already holds this fingerprint, leave it there (the
    // @unique column would reject a duplicate anyway).
    const taken = await prisma.profile.findFirst({
      where: { cardFingerprint: fp, userId: { not: p.userId } },
      select: { userId: true },
    });
    if (taken) {
      console.log(`- ${p.userId}: card already linked to ${taken.userId}, skipping`);
      skipped++;
      continue;
    }
    await prisma.profile.update({ where: { userId: p.userId }, data: { cardFingerprint: fp } });
    console.log(`- ${p.userId}: set ${fp}`);
    set++;
  } catch (e) {
    console.log(`- ${p.userId}: error ${(e as Error).message}`);
    skipped++;
  }
}

console.log(`Done. ${set} set, ${skipped} skipped.`);
process.exit(0);
