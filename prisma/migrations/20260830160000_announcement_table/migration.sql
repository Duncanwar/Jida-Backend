-- Announcements become rows of their own so they can be published publicly.
--
-- Purely additive: the existing per-account Notification rows are untouched, so
-- announcements already posted keep showing in everyone's notification feed.
-- Those older ones simply have no public page, which is correct — they were
-- written as internal notices.

CREATE TABLE "Announcement" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "isPublic" BOOLEAN NOT NULL DEFAULT false,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Announcement_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "Announcement_slug_key" ON "Announcement"("slug");
CREATE INDEX "Announcement_isPublic_createdAt_idx" ON "Announcement"("isPublic", "createdAt");
