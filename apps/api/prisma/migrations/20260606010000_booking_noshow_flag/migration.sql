-- Distinguish no-show releases from manual cancellations for analytics.
ALTER TABLE "Booking" ADD COLUMN "noShow" BOOLEAN NOT NULL DEFAULT false;
