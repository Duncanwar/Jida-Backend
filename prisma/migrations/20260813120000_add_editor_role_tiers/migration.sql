-- Editor tiers. Kept in a migration of their own: PostgreSQL forbids using a
-- value added by ALTER TYPE ... ADD VALUE inside the same transaction that
-- added it, and Prisma wraps each migration file in one transaction.

-- AlterEnum
ALTER TYPE "Role" ADD VALUE 'CHIEF_EDITOR';
ALTER TYPE "Role" ADD VALUE 'ASSOCIATE_EDITOR';
