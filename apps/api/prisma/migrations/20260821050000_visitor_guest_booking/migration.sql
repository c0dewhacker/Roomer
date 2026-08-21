-- AlterTable
ALTER TABLE "Booking" ADD COLUMN     "guestCheckInToken" TEXT,
ADD COLUMN     "guestEmail" TEXT,
ADD COLUMN     "guestName" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "Booking_guestCheckInToken_key" ON "Booking"("guestCheckInToken");
