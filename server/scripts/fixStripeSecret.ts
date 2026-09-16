import "dotenv/config";
import { PrismaClient } from "@prisma/client";

// One-off: drop a bad stripe.secretKey override (a publishable key was saved there) so .env wins.
const prisma = new PrismaClient();
try {
  const res = await prisma.platformSetting.deleteMany({ where: { key: "stripe.secretKey" } });
  console.log(`✅ Removed ${res.count} stripe.secretKey override — now using STRIPE_SECRET_KEY from .env.`);
} finally {
  await prisma.$disconnect();
}
