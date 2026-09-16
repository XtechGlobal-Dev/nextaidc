import "dotenv/config";
import { PrismaClient } from "@prisma/client";
import { seed } from "../prisma/seed.js";

// Runs on `npm run dev`: seed if no SUPER_ADMIN exists, else skip (never resets passwords). The super
// admin is the only account the seed creates — everyone else belongs to a brand.
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
