/**
 * Creates (or updates) the system admin account.
 *
 * Usage:
 *   ADMIN_EMAIL=admin@auca.ac.rw ADMIN_PASSWORD=change-me-now npm run seed:admin
 */
import { PrismaClient, Role } from "@prisma/client";
import bcrypt from "bcryptjs";

const prisma = new PrismaClient();

async function main(): Promise<void> {
  const email = process.env.ADMIN_EMAIL;
  const password = process.env.ADMIN_PASSWORD;

  if (!email || !password) {
    console.error("Set ADMIN_EMAIL and ADMIN_PASSWORD environment variables.");
    process.exit(1);
  }
  if (password.length < 8) {
    console.error("ADMIN_PASSWORD must be at least 8 characters.");
    process.exit(1);
  }

  const passwordHash = await bcrypt.hash(password, 10);
  const admin = await prisma.user.upsert({
    where: { email },
    create: {
      email,
      passwordHash,
      role: Role.ADMIN,
      firstName: "System",
      lastName: "Admin",
    },
    update: { passwordHash, role: Role.ADMIN },
  });

  console.info(`Admin account ready: ${admin.email} (${admin.id})`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
