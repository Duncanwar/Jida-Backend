-- FR-AUTH-1 / FR-AUTH-2: email verification + Google Identity Services sign-in.

-- 1. Auth provider enum ------------------------------------------------------
CREATE TYPE "AuthProvider" AS ENUM ('LOCAL', 'GOOGLE', 'BOTH');

-- 2. User: verification + Google columns -------------------------------------
ALTER TABLE "User"
  ADD COLUMN "emailVerified"   BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "emailVerifiedAt" TIMESTAMP(3),
  ADD COLUMN "authProvider"    "AuthProvider" NOT NULL DEFAULT 'LOCAL',
  ADD COLUMN "googleId"        TEXT,
  ADD COLUMN "avatarUrl"       TEXT;

-- Google-only accounts have no local password.
ALTER TABLE "User" ALTER COLUMN "passwordHash" DROP NOT NULL;

-- Backfill: accounts that already existed before verification was introduced
-- keep working. Locking out live users on deploy would be a regression, and
-- admins are trusted/provisioned out-of-band in any case.
UPDATE "User"
   SET "emailVerified" = true,
       "emailVerifiedAt" = COALESCE("createdAt", CURRENT_TIMESTAMP);

CREATE UNIQUE INDEX "User_googleId_key" ON "User"("googleId");
CREATE INDEX "User_emailVerified_idx" ON "User"("emailVerified");

-- 3. Email verification tokens -----------------------------------------------
CREATE TABLE "EmailVerificationToken" (
    "id"         TEXT NOT NULL,
    "userId"     TEXT NOT NULL,
    "tokenHash"  TEXT NOT NULL,
    "expiresAt"  TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),
    "sentCount"  INTEGER NOT NULL DEFAULT 1,
    "lastSentAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EmailVerificationToken_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "EmailVerificationToken_tokenHash_key" ON "EmailVerificationToken"("tokenHash");
CREATE INDEX "EmailVerificationToken_userId_idx" ON "EmailVerificationToken"("userId");
CREATE INDEX "EmailVerificationToken_expiresAt_idx" ON "EmailVerificationToken"("expiresAt");

ALTER TABLE "EmailVerificationToken"
  ADD CONSTRAINT "EmailVerificationToken_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
