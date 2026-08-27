-- Reverts the compiled-issue-PDF / import-past-issue feature: those flows were
-- removed, so the columns they added come back out. No data existed in them.

-- AlterTable
ALTER TABLE "Issue" DROP COLUMN "compiledOriginalName",
DROP COLUMN "compiledSizeBytes",
DROP COLUMN "compiledStoredName",
DROP COLUMN "compiledUploadedAt";

-- AlterTable
ALTER TABLE "Manuscript" DROP COLUMN "isExternal";

-- AlterTable
ALTER TABLE "Publication" DROP COLUMN "bundlePageEnd",
DROP COLUMN "bundlePageStart",
DROP COLUMN "pdfOriginalName",
DROP COLUMN "pdfSizeBytes",
DROP COLUMN "pdfStoredName";
