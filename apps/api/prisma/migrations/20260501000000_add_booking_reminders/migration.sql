-- Add booking reminder hours to Organisation (default 24 hours)
ALTER TABLE "Organisation" ADD COLUMN "bookingReminderHours" INTEGER NOT NULL DEFAULT 24;

-- Add reminderSentAt to Booking for deduplication
ALTER TABLE "Booking" ADD COLUMN "reminderSentAt" TIMESTAMP(3);

-- Add notificationPreferences to User (JSON, default empty object)
ALTER TABLE "User" ADD COLUMN "notificationPreferences" JSONB NOT NULL DEFAULT '{}';
