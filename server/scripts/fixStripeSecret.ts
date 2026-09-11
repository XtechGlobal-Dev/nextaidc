import "dotenv/config";
import { PrismaClient } from "@prisma/client";

/* One-off: remove a bad stripe.secretKey DB override so the correct
 * STRIPE_SECRET_KEY from .env is used. (A publishable key had been saved
 * into the secret-key slot via Admin → Settings.) */
const prisma = new PrismaClient();
try {
  const res = await prisma.platformSetting.deleteMany({ where: { key: "stripe.secretKey" } });
  console.log(`✅ Removed ${res.count} stripe.secretKey override — now using STRIPE_SECRET_KEY from .env.`);
} finally {
  await prisma.$disconnect();
}
