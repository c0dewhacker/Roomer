-- AlterEnum
ALTER TYPE "BookingStatus" ADD VALUE 'PENDING_APPROVAL';

-- AlterEnum
ALTER TYPE "NotificationType" ADD VALUE 'BOOKING_PENDING_APPROVAL';
ALTER TYPE "NotificationType" ADD VALUE 'BOOKING_APPROVED';
ALTER TYPE "NotificationType" ADD VALUE 'BOOKING_REJECTED';

-- AlterTable
ALTER TABLE "Booking" ADD COLUMN     "approvalExpiresAt" TIMESTAMP(3),
ADD COLUMN     "approvedAt" TIMESTAMP(3),
ADD COLUMN     "approvedByUserId" TEXT,
ADD COLUMN     "rejectionNote" TEXT;

-- AlterTable
ALTER TABLE "Building" ADD COLUMN     "requiresApproval" BOOLEAN;

-- AlterTable
ALTER TABLE "Organisation" ADD COLUMN     "approvalWindowHours" INTEGER NOT NULL DEFAULT 24,
ADD COLUMN     "requiresApproval" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "Zone" ADD COLUMN     "requiresApproval" BOOLEAN;

-- CreateIndex
CREATE INDEX "Booking_approvalExpiresAt_idx" ON "Booking"("approvalExpiresAt");

-- AddForeignKey
ALTER TABLE "Booking" ADD CONSTRAINT "Booking_approvedByUserId_fkey" FOREIGN KEY ("approvedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
