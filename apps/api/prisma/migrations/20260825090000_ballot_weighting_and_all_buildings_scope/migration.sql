-- CreateEnum
CREATE TYPE "BallotWeightScope" AS ENUM ('PER_BALLOT', 'GLOBAL');

-- AlterTable
ALTER TABLE "Ballot" ADD COLUMN     "scopeAllBuildings" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "Organisation" ADD COLUMN     "ballotWeightCapStreak" INTEGER NOT NULL DEFAULT 5,
ADD COLUMN     "ballotWeightIncrement" DOUBLE PRECISION NOT NULL DEFAULT 0.2,
ADD COLUMN     "ballotWeightScope" "BallotWeightScope" NOT NULL DEFAULT 'PER_BALLOT',
ADD COLUMN     "ballotWeightingEnabled" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "ballotConsecutiveLosses" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "BallotUserStreak" (
    "id" TEXT NOT NULL,
    "ballotId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "consecutiveLosses" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BallotUserStreak_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "BallotUserStreak_userId_idx" ON "BallotUserStreak"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "BallotUserStreak_ballotId_userId_key" ON "BallotUserStreak"("ballotId", "userId");

-- AddForeignKey
ALTER TABLE "BallotUserStreak" ADD CONSTRAINT "BallotUserStreak_ballotId_fkey" FOREIGN KEY ("ballotId") REFERENCES "Ballot"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BallotUserStreak" ADD CONSTRAINT "BallotUserStreak_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
