-- CreateEnum
CREATE TYPE "ManagerRequestStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'CANCELLED', 'EXPIRED');

-- CreateTable
CREATE TABLE "FloorManagerRequest" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "floorId" TEXT NOT NULL,
    "status" "ManagerRequestStatus" NOT NULL DEFAULT 'PENDING',
    "note" TEXT,
    "reviewedById" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "reviewNote" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FloorManagerRequest_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "FloorManagerRequest_userId_idx" ON "FloorManagerRequest"("userId");

-- CreateIndex
CREATE INDEX "FloorManagerRequest_floorId_idx" ON "FloorManagerRequest"("floorId");

-- CreateIndex
CREATE INDEX "FloorManagerRequest_status_idx" ON "FloorManagerRequest"("status");

-- AddForeignKey
ALTER TABLE "FloorManagerRequest" ADD CONSTRAINT "FloorManagerRequest_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FloorManagerRequest" ADD CONSTRAINT "FloorManagerRequest_floorId_fkey" FOREIGN KEY ("floorId") REFERENCES "Floor"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FloorManagerRequest" ADD CONSTRAINT "FloorManagerRequest_reviewedById_fkey" FOREIGN KEY ("reviewedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
