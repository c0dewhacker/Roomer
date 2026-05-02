-- CreateEnum
CREATE TYPE "RecurringFrequency" AS ENUM ('DAILY', 'WEEKLY', 'MONTHLY');

-- AlterTable: add frequency, make dayOfWeek nullable, backfill existing rows as WEEKLY
ALTER TABLE "RecurringBookingRule"
  ADD COLUMN "frequency" "RecurringFrequency" NOT NULL DEFAULT 'WEEKLY',
  ALTER COLUMN "dayOfWeek" DROP NOT NULL;
