-- AlterTable
ALTER TABLE "Issue" ADD COLUMN     "compiledOriginalName" TEXT,
ADD COLUMN     "compiledSizeBytes" INTEGER,
ADD COLUMN     "compiledStoredName" TEXT,
ADD COLUMN     "compiledUploadedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "Publication" ADD COLUMN     "bundlePageEnd" INTEGER,
ADD COLUMN     "bundlePageStart" INTEGER,
ADD COLUMN     "pdfOriginalName" TEXT,
ADD COLUMN     "pdfSizeBytes" INTEGER,
ADD COLUMN     "pdfStoredName" TEXT;
