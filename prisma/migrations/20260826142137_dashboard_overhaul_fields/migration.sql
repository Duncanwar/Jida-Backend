-- CreateEnum
CREATE TYPE "DecisionStage" AS ENUM ('INITIAL_SCREENING', 'FINAL_SCREENING');

-- AlterTable
ALTER TABLE "CoAuthor" ALTER COLUMN "email" DROP NOT NULL;

-- AlterTable
ALTER TABLE "EditorialDecision" ADD COLUMN     "stage" "DecisionStage";

-- AlterTable
ALTER TABLE "Issue" ADD COLUMN     "specialIssue" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "Manuscript" ADD COLUMN     "submissionDeadline" TIMESTAMP(3);
