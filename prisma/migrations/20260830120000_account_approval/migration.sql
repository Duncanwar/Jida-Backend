-- Chief Editor approval gate for new accounts.
--
-- The column defaults to PENDING for accounts created from now on, but every
-- account that already exists belongs to the working team — the editor, the
-- reviewer, the authors and the admin. Backfilling them to APPROVED is the
-- whole point of this migration: without it, deploying this feature would lock
-- the entire journal out of its own system.

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
