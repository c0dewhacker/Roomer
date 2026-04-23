-- AlterTable
ALTER TABLE "Organisation" ADD COLUMN IF NOT EXISTS "queueClaimWindowHours" INTEGER NOT NULL DEFAULT 4;
