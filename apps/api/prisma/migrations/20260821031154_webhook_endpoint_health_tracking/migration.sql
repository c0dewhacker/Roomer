-- AlterTable
ALTER TABLE "WebhookEndpoint" ADD COLUMN     "consecutiveFailures" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "lastSuccessAt" TIMESTAMP(3);
