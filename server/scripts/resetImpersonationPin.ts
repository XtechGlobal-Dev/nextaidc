import "dotenv/config";
import { PrismaClient } from "@prisma/client";

/* ------------------------------------------------------------------ *
 *  Reset the "Login as Customer" PIN back to its default (000000).
 *
 *  The last resort, for when the in-app "Forgot PIN?" can't be used —
 *  SMTP is down, the admin mailbox is gone, or the reset email never
 *  arrives. The PIN is stored as a bcrypt hash, so it can never be
 *  recovered, only replaced; deleting the row puts the default back.
 *
 *  Also clears the lockout, since being locked out is one of the
 *  reasons to be running this.
 *
 *      npm run reset-impersonation-pin
 *
 *  Anyone who can run this already has database credentials, so it adds
 *  no access they didn't have — it just means they don't have to hand-
 *  write DELETE statements against a live database to get back in.
 * ------------------------------------------------------------------ */

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
