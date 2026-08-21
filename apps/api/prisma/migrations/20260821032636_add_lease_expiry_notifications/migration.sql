-- AlterEnum
ALTER TYPE "NotificationType" ADD VALUE 'LEASE_EXPIRING';
ALTER TYPE "NotificationType" ADD VALUE 'LEASE_EXPIRED';

-- AlterTable
ALTER TABLE "BuildingLease" ADD COLUMN     "expiredNotifiedAt" TIMESTAMP(3),
ADD COLUMN     "expiringNotifiedAt" TIMESTAMP(3);
