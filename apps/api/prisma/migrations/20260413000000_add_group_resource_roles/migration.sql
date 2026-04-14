-- CreateTable
CREATE TABLE "GroupResourceRole" (
    "id" TEXT NOT NULL,
    "groupId" TEXT NOT NULL,
    "role" "ResourceRoleType" NOT NULL,
    "scopeType" "ResourceScopeType" NOT NULL,
    "buildingId" TEXT,
    "floorId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GroupResourceRole_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "GroupResourceRole_groupId_idx" ON "GroupResourceRole"("groupId");

-- CreateIndex
CREATE UNIQUE INDEX "GroupResourceRole_groupId_scopeType_buildingId_floorId_key" ON "GroupResourceRole"("groupId", "scopeType", "buildingId", "floorId");

-- AddForeignKey
ALTER TABLE "GroupResourceRole" ADD CONSTRAINT "GroupResourceRole_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "UserGroup"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GroupResourceRole" ADD CONSTRAINT "GroupResourceRole_buildingId_fkey" FOREIGN KEY ("buildingId") REFERENCES "Building"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GroupResourceRole" ADD CONSTRAINT "GroupResourceRole_floorId_fkey" FOREIGN KEY ("floorId") REFERENCES "Floor"("id") ON DELETE CASCADE ON UPDATE CASCADE;
