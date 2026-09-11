import "dotenv/config";
import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";

/* ------------------------------------------------------------------ *
 *  Ensure the platform SUPER_ADMIN exists.
 *
 *  Unlike `ensureAdmin`, this runs on an already-populated database: an
 *  existing deployment has plenty of ADMINs but no super admin, and the
 *  full seed would also touch plans and templates. This touches exactly
 *  one row.
 *
 *  Credentials come from the environment, falling back to the documented
 *  defaults:
 *    SEED_SUPER_ADMIN_EMAIL     (default superadmin@ai.com)
 *    SEED_SUPER_ADMIN_PASSWORD  (default Super@001)
 *    SEED_SUPER_ADMIN_NAME      (default "Super Admin")
 *
 *  Idempotent: run it again to reset the password to the configured one.
 *
 *  Usage:  npm run ensure-super-admin      (from server/)
 * ------------------------------------------------------------------ */

const prisma = new PrismaClient();

const email = process.env.SEED_SUPER_ADMIN_EMAIL ?? "superadmin@ai.com";
const password = process.env.SEED_SUPER_ADMIN_PASSWORD ?? "Super@001";
const fullName = process.env.SEED_SUPER_ADMIN_NAME ?? "Super Admin";

try {
  const passwordHash = await bcrypt.hash(password, 10);
  const existing = await prisma.user.findUnique({ where: { email } });

  const user = await prisma.user.upsert({
    where: { email },
    update: { role: "SUPER_ADMIN", fullName, passwordHash },
    create: { email, fullName, role: "SUPER_ADMIN", passwordHash },
    select: { id: true, email: true, role: true },
  });

  console.log(
    existing
      ? `✅ Super admin updated: ${user.email} (role ${user.role}, password reset)`
      : `✅ Super admin created: ${user.email}`,
  );
} finally {
  await prisma.$disconnect();
}
