-- Add defaultBookingDurationHours to Organisation (was in schema but missing from migrations)
ALTER TABLE "Organisation"
  ADD COLUMN IF NOT EXISTS "defaultBookingDurationHours" INTEGER NOT NULL DEFAULT 8;
