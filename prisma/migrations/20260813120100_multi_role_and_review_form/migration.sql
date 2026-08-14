-- CreateEnum
CREATE TYPE "ReviewRating" AS ENUM ('EXCELLENT', 'GOOD', 'MODERATE', 'POOR', 'BAD');

-- AlterTable: an account's full authorization set. Backfilled from the primary
-- role so existing users keep exactly the access they had before this change.
ALTER TABLE "User" ADD COLUMN "roles" "Role"[];
UPDATE "User" SET "roles" = ARRAY["role"] WHERE "roles" IS NULL;

-- AlterTable: a reference list is no longer required at submission time.
ALTER TABLE "Manuscript" ALTER COLUMN "references" DROP NOT NULL;

-- AlterTable: the manuscript review form.
-- "Confidential Comments (if any)" is optional on the form, so the column that
-- backs it stops being NOT NULL.
ALTER TABLE "Review" ALTER COLUMN "commentsToEditor" DROP NOT NULL;
ALTER TABLE "Review" ADD COLUMN     "specificSuggestions" TEXT,
ADD COLUMN     "ratingTitle" "ReviewRating",
ADD COLUMN     "ratingAbstract" "ReviewRating",
ADD COLUMN     "ratingLiterature" "ReviewRating",
ADD COLUMN     "ratingMethods" "ReviewRating",
ADD COLUMN     "ratingConclusions" "ReviewRating",
ADD COLUMN     "ratingReferences" "ReviewRating",
ADD COLUMN     "ratingStructure" "ReviewRating";

-- CreateTable
CREATE TABLE "CoAuthor" (
    "id" TEXT NOT NULL,
    "manuscriptId" TEXT NOT NULL,
    "fullName" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "affiliation" TEXT,
    "isCorresponding" BOOLEAN NOT NULL DEFAULT false,
    "position" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CoAuthor_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CoAuthor_manuscriptId_idx" ON "CoAuthor"("manuscriptId");

-- AddForeignKey
ALTER TABLE "CoAuthor" ADD CONSTRAINT "CoAuthor_manuscriptId_fkey" FOREIGN KEY ("manuscriptId") REFERENCES "Manuscript"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- CreateTable
CREATE TABLE "ReviewerFeedback" (
    "id" TEXT NOT NULL,
    "reviewId" TEXT NOT NULL,
    "authorId" TEXT NOT NULL,
    "rating" INTEGER NOT NULL,
    "comment" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ReviewerFeedback_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ReviewerFeedback_reviewId_key" ON "ReviewerFeedback"("reviewId");

-- CreateIndex
CREATE INDEX "ReviewerFeedback_authorId_idx" ON "ReviewerFeedback"("authorId");

-- AddForeignKey
ALTER TABLE "ReviewerFeedback" ADD CONSTRAINT "ReviewerFeedback_reviewId_fkey" FOREIGN KEY ("reviewId") REFERENCES "Review"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReviewerFeedback" ADD CONSTRAINT "ReviewerFeedback_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
