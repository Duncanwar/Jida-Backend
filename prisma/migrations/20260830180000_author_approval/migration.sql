-- Approval gate for self-registered authors.
--
-- Reinstates 20260830120000_account_approval, which 20260830140000 reverted.
-- Written forward rather than by un-reverting, so the history reads honestly.
--
-- The column defaults to PENDING for accounts created from here on, but every
-- account that already exists belongs to the working journal — the editor, the
-- reviewer, the authors, the admin. Backfilling them to APPROVED is the whole
-- point of this migration: without it, deploying this locks the entire journal
-- out of its own submission form.

CREATE TYPE "AccountStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');

ALTER TABLE "User" ADD COLUMN "accountStatus" "AccountStatus" NOT NULL DEFAULT 'PENDING';
ALTER TABLE "User" ADD COLUMN "accountStatusAt" TIMESTAMP(3);
ALTER TABLE "User" ADD COLUMN "accountStatusBy" TEXT;
ALTER TABLE "User" ADD COLUMN "rejectionReason" TEXT;

-- Everyone who existed before the gate is grandfathered in.
UPDATE "User"
SET "accountStatus" = 'APPROVED',
    "accountStatusAt" = NOW()
WHERE "accountStatus" = 'PENDING';

CREATE INDEX "User_accountStatus_idx" ON "User"("accountStatus");
