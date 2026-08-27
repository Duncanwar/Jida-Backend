-- CreateEnum
CREATE TYPE "AssignmentResponse" AS ENUM ('PENDING', 'ACCEPTED', 'DECLINED');

-- CreateEnum
CREATE TYPE "InvitationStatus" AS ENUM ('PENDING', 'ACCEPTED', 'DECLINED', 'EXPIRED');

-- AlterTable
ALTER TABLE "Manuscript" ADD COLUMN     "isRevised" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "Notification" ADD COLUMN     "kind" TEXT NOT NULL DEFAULT 'GENERIC',
ADD COLUMN     "refId" TEXT;

-- AlterTable
ALTER TABLE "ReviewAssignment" ADD COLUMN     "declineReason" TEXT,
ADD COLUMN     "respondedAt" TIMESTAMP(3),
ADD COLUMN     "response" "AssignmentResponse" NOT NULL DEFAULT 'PENDING',
ADD COLUMN     "responseToken" TEXT;

-- CreateTable
CREATE TABLE "ReviewerInvitation" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "invitedById" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "status" "InvitationStatus" NOT NULL DEFAULT 'PENDING',
    "declineReason" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "respondedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ReviewerInvitation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ReviewerInvitation_tokenHash_key" ON "ReviewerInvitation"("tokenHash");

-- CreateIndex
CREATE INDEX "ReviewerInvitation_email_idx" ON "ReviewerInvitation"("email");

-- CreateIndex
CREATE INDEX "ReviewerInvitation_invitedById_idx" ON "ReviewerInvitation"("invitedById");

-- CreateIndex
CREATE UNIQUE INDEX "ReviewAssignment_responseToken_key" ON "ReviewAssignment"("responseToken");

-- AddForeignKey
ALTER TABLE "ReviewerInvitation" ADD CONSTRAINT "ReviewerInvitation_invitedById_fkey" FOREIGN KEY ("invitedById") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
