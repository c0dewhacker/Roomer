-- Manager-derived org hierarchy: per-user manager link, drop department hierarchy.

-- User manager link (self-relation) + raw IdP ref for deferred resolution.
ALTER TABLE "User" ADD COLUMN "managerId" TEXT;
ALTER TABLE "User" ADD COLUMN "managerExternalRef" TEXT;
ALTER TABLE "User"
  ADD CONSTRAINT "User_managerId_fkey"
  FOREIGN KEY ("managerId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
CREATE INDEX "User_managerId_idx" ON "User"("managerId");

-- Departments are now flat — hierarchy is inferred from manager links.
ALTER TABLE "Department" DROP CONSTRAINT IF EXISTS "Department_parentId_fkey";
DROP INDEX IF EXISTS "Department_parentId_idx";
ALTER TABLE "Department" DROP COLUMN IF EXISTS "parentId";
