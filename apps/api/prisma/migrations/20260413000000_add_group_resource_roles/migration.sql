-- CreateTable
CREATE TABLE "UserGroup" (
    "id" TEXT NOT NULL,
    "organisationId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "globalRole" "GlobalRole" NOT NULL DEFAULT 'USER',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UserGroup_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UserGroupMember" (
    "groupId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UserGroupMember_pkey" PRIMARY KEY ("groupId","userId")
);

-- CreateTable
CREATE TABLE "GroupBuildingAccess" (
    "groupId" TEXT NOT NULL,
    "buildingId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GroupBuildingAccess_pkey" PRIMARY KEY ("groupId","buildingId")
);

-- CreateTable
CREATE TABLE "GroupFloorAccess" (
    "groupId" TEXT NOT NULL,
    "floorId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GroupFloorAccess_pkey" PRIMARY KEY ("groupId","floorId")
);

-- CreateIndex
CREATE UNIQUE INDEX "UserGroup_organisationId_name_key" ON "UserGroup"("organisationId", "name");

-- CreateIndex
CREATE INDEX "UserGroup_organisationId_idx" ON "UserGroup"("organisationId");

-- AddForeignKey
ALTER TABLE "UserGroup" ADD CONSTRAINT "UserGroup_organisationId_fkey" FOREIGN KEY ("organisationId") REFERENCES "Organisation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserGroupMember" ADD CONSTRAINT "UserGroupMember_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "UserGroup"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserGroupMember" ADD CONSTRAINT "UserGroupMember_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GroupBuildingAccess" ADD CONSTRAINT "GroupBuildingAccess_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "UserGroup"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GroupBuildingAccess" ADD CONSTRAINT "GroupBuildingAccess_buildingId_fkey" FOREIGN KEY ("buildingId") REFERENCES "Building"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GroupFloorAccess" ADD CONSTRAINT "GroupFloorAccess_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "UserGroup"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GroupFloorAccess" ADD CONSTRAINT "GroupFloorAccess_floorId_fkey" FOREIGN KEY ("floorId") REFERENCES "Floor"("id") ON DELETE CASCADE ON UPDATE CASCADE;

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
