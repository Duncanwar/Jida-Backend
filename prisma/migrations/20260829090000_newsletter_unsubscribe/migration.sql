-- Newsletter unsubscribe support.
--
-- `unsubscribeToken` is required and unique, but the table already holds rows,
-- so it cannot be added as NOT NULL in one step. Add it nullable, backfill a
-- distinct value per existing row, then tighten it.

ALTER TABLE "NewsletterSubscriber" ADD COLUMN "unsubscribeToken" TEXT;
ALTER TABLE "NewsletterSubscriber" ADD COLUMN "unsubscribedAt" TIMESTAMP(3);

UPDATE "NewsletterSubscriber"
SET "unsubscribeToken" = gen_random_uuid()::TEXT
WHERE "unsubscribeToken" IS NULL;

ALTER TABLE "NewsletterSubscriber" ALTER COLUMN "unsubscribeToken" SET NOT NULL;

CREATE UNIQUE INDEX "NewsletterSubscriber_unsubscribeToken_key"
  ON "NewsletterSubscriber"("unsubscribeToken");
