-- CreateEnum
CREATE TYPE "BallotFrequency" AS ENUM ('ONCE', 'WEEKLY', 'MONTHLY');

-- CreateEnum
CREATE TYPE "BallotStatus" AS ENUM ('ACTIVE', 'PAUSED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "BallotRunStatus" AS ENUM ('OPEN', 'DRAWN', 'CANCELLED');

-- CreateEnum
CREATE TYPE "BallotEntryStatus" AS ENUM ('ENTERED', 'WON', 'DECLINED', 'LOST');

-- AlterEnum
ALTER TYPE "NotificationType" ADD VALUE 'BALLOT_WON';
ALTER TYPE "NotificationType" ADD VALUE 'BALLOT_LOST';

-- CreateTable
CREATE TABLE "Ballot" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "createdByUserId" TEXT NOT NULL,
    "buildingIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "floorIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "assetCategoryIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "frequency" "BallotFrequency" NOT NULL DEFAULT 'WEEKLY',
    "dayOfWeek" INTEGER,
    "dayOfMonth" INTEGER,
    "registrationWindowHours" INTEGER NOT NULL DEFAULT 72,
    "slotStartTime" TEXT NOT NULL DEFAULT '00:00',
    "slotEndTime" TEXT NOT NULL DEFAULT '23:59',
    "slotLeadDays" INTEGER NOT NULL DEFAULT 1,
    "slotDurationDays" INTEGER NOT NULL DEFAULT 1,
    "status" "BallotStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Ballot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BallotRun" (
    "id" TEXT NOT NULL,
    "ballotId" TEXT NOT NULL,
    "registrationOpensAt" TIMESTAMP(3) NOT NULL,
    "registrationClosesAt" TIMESTAMP(3) NOT NULL,
    "slotStartsAt" TIMESTAMP(3) NOT NULL,
    "slotEndsAt" TIMESTAMP(3) NOT NULL,
    "status" "BallotRunStatus" NOT NULL DEFAULT 'OPEN',
    "drawnAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BallotRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BallotEntry" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "status" "BallotEntryStatus" NOT NULL DEFAULT 'ENTERED',
    "assetId" TEXT,
    "bookingId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BallotEntry_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "BallotRun_ballotId_idx" ON "BallotRun"("ballotId");

-- CreateIndex
CREATE INDEX "BallotRun_status_registrationClosesAt_idx" ON "BallotRun"("status", "registrationClosesAt");

-- CreateIndex
CREATE UNIQUE INDEX "BallotEntry_bookingId_key" ON "BallotEntry"("bookingId");

-- CreateIndex
CREATE INDEX "BallotEntry_userId_idx" ON "BallotEntry"("userId");

-- CreateIndex
CREATE INDEX "BallotEntry_assetId_idx" ON "BallotEntry"("assetId");

-- CreateIndex
CREATE UNIQUE INDEX "BallotEntry_runId_userId_key" ON "BallotEntry"("runId", "userId");

-- AddForeignKey
ALTER TABLE "Ballot" ADD CONSTRAINT "Ballot_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BallotRun" ADD CONSTRAINT "BallotRun_ballotId_fkey" FOREIGN KEY ("ballotId") REFERENCES "Ballot"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BallotEntry" ADD CONSTRAINT "BallotEntry_runId_fkey" FOREIGN KEY ("runId") REFERENCES "BallotRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BallotEntry" ADD CONSTRAINT "BallotEntry_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BallotEntry" ADD CONSTRAINT "BallotEntry_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "Asset"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BallotEntry" ADD CONSTRAINT "BallotEntry_bookingId_fkey" FOREIGN KEY ("bookingId") REFERENCES "Booking"("id") ON DELETE SET NULL ON UPDATE CASCADE;
