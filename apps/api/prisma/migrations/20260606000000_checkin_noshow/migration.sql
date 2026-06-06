-- Check-in / no-show detection.
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'BOOKING_NO_SHOW';

ALTER TABLE "Booking" ADD COLUMN "checkedInAt" TIMESTAMP(3);

ALTER TABLE "Organisation" ADD COLUMN "noShowReleaseEnabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Organisation" ADD COLUMN "checkInGraceMinutes" INTEGER NOT NULL DEFAULT 30;

-- Per-building / per-floor overrides (nullable = inherit from the parent scope).
ALTER TABLE "Building" ADD COLUMN "noShowReleaseEnabled" BOOLEAN;
ALTER TABLE "Floor" ADD COLUMN "noShowReleaseEnabled" BOOLEAN;

-- Helps the release job find un-checked-in active bookings quickly.
CREATE INDEX "Booking_status_checkedInAt_startsAt_idx" ON "Booking"("status", "checkedInAt", "startsAt");
