-- CreateEnum
CREATE TYPE "TransferRequestStatus" AS ENUM ('PENDING', 'ACCEPTED', 'DECLINED', 'CANCELLED', 'EXPIRED');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "NotificationType" ADD VALUE 'BOOKING_TRANSFER_REQUESTED';
ALTER TYPE "NotificationType" ADD VALUE 'BOOKING_TRANSFER_ACCEPTED';
ALTER TYPE "NotificationType" ADD VALUE 'BOOKING_TRANSFER_DECLINED';
ALTER TYPE "NotificationType" ADD VALUE 'BOOKING_TRANSFER_EXPIRED';
ALTER TYPE "NotificationType" ADD VALUE 'BOOKING_SWAP_REQUESTED';
ALTER TYPE "NotificationType" ADD VALUE 'BOOKING_SWAP_ACCEPTED';
ALTER TYPE "NotificationType" ADD VALUE 'BOOKING_SWAP_DECLINED';
ALTER TYPE "NotificationType" ADD VALUE 'BOOKING_SWAP_EXPIRED';

-- CreateTable
CREATE TABLE "BookingTransfer" (
    "id" TEXT NOT NULL,
    "bookingId" TEXT NOT NULL,
    "fromUserId" TEXT NOT NULL,
    "toUserId" TEXT NOT NULL,
    "status" "TransferRequestStatus" NOT NULL DEFAULT 'PENDING',
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "respondedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BookingTransfer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BookingSwap" (
    "id" TEXT NOT NULL,
    "bookingAId" TEXT NOT NULL,
    "bookingBId" TEXT NOT NULL,
    "initiatorUserId" TEXT NOT NULL,
    "recipientUserId" TEXT NOT NULL,
    "status" "TransferRequestStatus" NOT NULL DEFAULT 'PENDING',
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "respondedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BookingSwap_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "BookingTransfer_bookingId_idx" ON "BookingTransfer"("bookingId");

-- CreateIndex
CREATE INDEX "BookingTransfer_toUserId_status_idx" ON "BookingTransfer"("toUserId", "status");

-- CreateIndex
CREATE INDEX "BookingTransfer_status_expiresAt_idx" ON "BookingTransfer"("status", "expiresAt");

-- CreateIndex
CREATE INDEX "BookingSwap_bookingAId_idx" ON "BookingSwap"("bookingAId");

-- CreateIndex
CREATE INDEX "BookingSwap_bookingBId_idx" ON "BookingSwap"("bookingBId");

-- CreateIndex
CREATE INDEX "BookingSwap_recipientUserId_status_idx" ON "BookingSwap"("recipientUserId", "status");

-- CreateIndex
CREATE INDEX "BookingSwap_status_expiresAt_idx" ON "BookingSwap"("status", "expiresAt");

-- AddForeignKey
ALTER TABLE "BookingTransfer" ADD CONSTRAINT "BookingTransfer_bookingId_fkey" FOREIGN KEY ("bookingId") REFERENCES "Booking"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BookingTransfer" ADD CONSTRAINT "BookingTransfer_fromUserId_fkey" FOREIGN KEY ("fromUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BookingTransfer" ADD CONSTRAINT "BookingTransfer_toUserId_fkey" FOREIGN KEY ("toUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BookingSwap" ADD CONSTRAINT "BookingSwap_bookingAId_fkey" FOREIGN KEY ("bookingAId") REFERENCES "Booking"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BookingSwap" ADD CONSTRAINT "BookingSwap_bookingBId_fkey" FOREIGN KEY ("bookingBId") REFERENCES "Booking"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BookingSwap" ADD CONSTRAINT "BookingSwap_initiatorUserId_fkey" FOREIGN KEY ("initiatorUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BookingSwap" ADD CONSTRAINT "BookingSwap_recipientUserId_fkey" FOREIGN KEY ("recipientUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
