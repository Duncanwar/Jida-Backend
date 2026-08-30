-- Reverts 20260830120000_account_approval at the author's request.
--
-- The approval gate is removed entirely: registration is open again, and no
-- account waits to be recognised. The forward migration is left in history
-- rather than deleted, so the sequence still replays correctly on a fresh
-- database.

ALTER TABLE "User" DROP COLUMN IF EXISTS "accountStatus";
ALTER TABLE "User" DROP COLUMN IF EXISTS "accountStatusAt";
ALTER TABLE "User" DROP COLUMN IF EXISTS "accountStatusBy";
ALTER TABLE "User" DROP COLUMN IF EXISTS "rejectionReason";

DROP TYPE IF EXISTS "AccountStatus";
