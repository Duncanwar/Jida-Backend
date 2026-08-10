-- CreateEnum
CREATE TYPE "FileSource" AS ENUM ('AUTHOR', 'EDITOR');

-- AlterTable
ALTER TABLE "ManuscriptFile" ADD COLUMN     "remarks" TEXT,
ADD COLUMN     "source" "FileSource" NOT NULL DEFAULT 'AUTHOR';

-- AlterTable
ALTER TABLE "Review" ADD COLUMN     "attachmentMimeType" TEXT,
ADD COLUMN     "attachmentOriginalName" TEXT,
ADD COLUMN     "attachmentSizeBytes" INTEGER,
ADD COLUMN     "attachmentStoredName" TEXT;
