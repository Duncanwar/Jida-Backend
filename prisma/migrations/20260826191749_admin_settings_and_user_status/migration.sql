-- AlterTable
ALTER TABLE "JournalSettings" ADD COLUMN     "automaticBackupsEnabled" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "emailNotificationsEnabled" BOOLEAN NOT NULL DEFAULT true;

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "isActive" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "lastLoginAt" TIMESTAMP(3);
