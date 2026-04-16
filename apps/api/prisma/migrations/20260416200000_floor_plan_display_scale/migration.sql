-- Add displayScale to FloorPlan so admins can scale the background image
-- independently of the canvas zoom. Default 1.0 (native resolution).
ALTER TABLE "FloorPlan" ADD COLUMN IF NOT EXISTS "displayScale" DOUBLE PRECISION NOT NULL DEFAULT 1.0;
