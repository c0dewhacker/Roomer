-- AlterTable
ALTER TABLE "Building" ADD COLUMN     "timezone" TEXT,
ADD COLUMN     "workingHoursEnd" TEXT,
ADD COLUMN     "workingHoursStart" TEXT;

-- AlterTable
ALTER TABLE "Organisation" ADD COLUMN     "defaultTimezone" TEXT NOT NULL DEFAULT 'UTC',
ADD COLUMN     "enforceWorkingHours" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "workingHoursEnd" TEXT NOT NULL DEFAULT '19:00',
ADD COLUMN     "workingHoursStart" TEXT NOT NULL DEFAULT '07:00';
