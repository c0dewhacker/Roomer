-- CreateEnum
CREATE TYPE "RecurringRuleStatus" AS ENUM ('ACTIVE', 'CANCELLED');

-- AlterTable: Organisation
ALTER TABLE "Organisation" ADD COLUMN "maxRecurringBookingWeeks" INTEGER NOT NULL DEFAULT 12;

-- AlterTable: Booking
ALTER TABLE "Booking" ADD COLUMN "recurringRuleId" TEXT;

-- CreateTable
CREATE TABLE "RecurringBookingRule" (
    "id"          TEXT NOT NULL,
    "userId"      TEXT NOT NULL,
    "assetId"     TEXT NOT NULL,
    "dayOfWeek"   INTEGER NOT NULL,
    "startTime"   TEXT NOT NULL,
    "endTime"     TEXT NOT NULL,
    "firstDate"   DATE NOT NULL,
    "lastDate"    DATE NOT NULL,
    "status"      "RecurringRuleStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"   TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RecurringBookingRule_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "RecurringBookingRule_userId_idx" ON "RecurringBookingRule"("userId");
CREATE INDEX "RecurringBookingRule_assetId_idx" ON "RecurringBookingRule"("assetId");
CREATE INDEX "Booking_recurringRuleId_idx" ON "Booking"("recurringRuleId");

-- AddForeignKey
ALTER TABLE "RecurringBookingRule" ADD CONSTRAINT "RecurringBookingRule_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "RecurringBookingRule" ADD CONSTRAINT "RecurringBookingRule_assetId_fkey"
    FOREIGN KEY ("assetId") REFERENCES "Asset"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "Booking" ADD CONSTRAINT "Booking_recurringRuleId_fkey"
    FOREIGN KEY ("recurringRuleId") REFERENCES "RecurringBookingRule"("id") ON DELETE SET NULL ON UPDATE CASCADE;
