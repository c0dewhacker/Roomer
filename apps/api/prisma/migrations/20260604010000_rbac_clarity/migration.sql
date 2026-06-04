-- RBAC clarity changes:
--   1. Provenance (MANUAL vs IDP) on group memberships and role grants so
--      directory sync never silently undoes admin-made changes.
--   2. Last-seen IdP group values per user (for the mapping dry-run + copy help).
--   3. Drop the unused VIEWER / USER values from ResourceRoleType.

-- 1 + 2 — RoleSource enum and provenance columns
CREATE TYPE "RoleSource" AS ENUM ('MANUAL', 'IDP');

ALTER TABLE "UserGroupMember"  ADD COLUMN "source" "RoleSource" NOT NULL DEFAULT 'MANUAL';
ALTER TABLE "UserResourceRole" ADD COLUMN "source" "RoleSource" NOT NULL DEFAULT 'MANUAL';
ALTER TABLE "GroupResourceRole" ADD COLUMN "source" "RoleSource" NOT NULL DEFAULT 'MANUAL';

ALTER TABLE "User" ADD COLUMN "globalRoleSource" "RoleSource" NOT NULL DEFAULT 'MANUAL';
ALTER TABLE "User" ADD COLUMN "lastIdpGroups" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "User" ADD COLUMN "lastSsoLoginAt" TIMESTAMP(3);

-- 3 — Recreate ResourceRoleType without the unused VIEWER / USER values.
-- Safe because no rows reference them (they were never assigned by any code path).
ALTER TYPE "ResourceRoleType" RENAME TO "ResourceRoleType_old";
CREATE TYPE "ResourceRoleType" AS ENUM ('BUILDING_ADMIN', 'FLOOR_MANAGER');
ALTER TABLE "UserResourceRole"  ALTER COLUMN "role" TYPE "ResourceRoleType" USING ("role"::text::"ResourceRoleType");
ALTER TABLE "GroupResourceRole" ALTER COLUMN "role" TYPE "ResourceRoleType" USING ("role"::text::"ResourceRoleType");
DROP TYPE "ResourceRoleType_old";
