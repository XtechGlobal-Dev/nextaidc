import "dotenv/config";
import { PrismaClient } from "@prisma/client";
import { seed } from "../prisma/seed.js";

/* ------------------------------------------------------------------ *
 *  Ensure the platform owner exists. Runs on `npm run dev`.
 *  - No SUPER_ADMIN in the DB -> applies the seed (super admin, trial
 *                                defaults, plan tiers)
 *  - Already there            -> skips (won't reset passwords)
 *
 *  The SUPER_ADMIN is the only account the seed creates: every other
 *  account belongs to a brand, so brand admins come from the Brands page and
 *  customers from a brand's own sign-up door.
 * ------------------------------------------------------------------ */
const prisma = new PrismaClient();

try {
  const owners = await prisma.user.count({ where: { role: "SUPER_ADMIN" } });
  if (owners === 0) {
    console.log("No super admin found — seeding…");
    await seed();
  } else {
    console.log("✅ Super admin already exists — skipping seed.");
  }
} finally {
  await prisma.$disconnect();
}
