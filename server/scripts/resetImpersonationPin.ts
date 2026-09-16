import "dotenv/config";
import { PrismaClient } from "@prisma/client";

// Last-resort reset of the "Login as Customer" PIN to 000000 (bcrypt hash can only be replaced) and clear
// the lockout. Adds no access — anyone running this already has DB credentials.

const PIN_HASH_KEY = "admin.impersonationPinHash";
const PIN_LOCK_KEY = "admin.impersonationPinLock";

const prisma = new PrismaClient();

try {
  const { count } = await prisma.platformSetting.deleteMany({
    where: { key: { in: [PIN_HASH_KEY, PIN_LOCK_KEY] } },
  });

  if (count === 0) {
    console.log("Nothing to clear — the PIN was already the default (000000).");
  } else {
    console.log("✅ Access PIN reset to 000000 and any lockout cleared.");
  }
  console.log(
    "\n⚠  Set a real PIN now: open a customer's detail page, click the 👋 in the\n" +
      "   header greeting, then \"Change PIN\". Until you do, the PIN protects nothing.",
  );
} finally {
  await prisma.$disconnect();
}
