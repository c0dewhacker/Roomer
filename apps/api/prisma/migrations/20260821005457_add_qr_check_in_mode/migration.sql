-- CreateEnum
CREATE TYPE "QrCheckInMode" AS ENUM ('DISABLED', 'OPTIONAL', 'MANDATORY');

-- AlterTable
ALTER TABLE "Building" ADD COLUMN     "qrCheckInMode" "QrCheckInMode";

-- AlterTable
ALTER TABLE "Floor" ADD COLUMN     "qrCheckInMode" "QrCheckInMode";

-- AlterTable
ALTER TABLE "Organisation" ADD COLUMN     "qrCheckInMode" "QrCheckInMode" NOT NULL DEFAULT 'DISABLED';
