import "dotenv/config";
import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";

// Upsert the SUPER_ADMIN on an already-populated DB (the full seed would also touch plans/templates).
// Credentials from SEED_SUPER_ADMIN_{EMAIL,PASSWORD,NAME}; re-running resets the password.

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
