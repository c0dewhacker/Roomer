-- Catch-up migration: brings the database fully in sync with schema.prisma.
-- Adds missing tables (AuthConfig, BuildingLease, LeaseDocument), missing
-- columns (Organisation.maxAdvanceBookingDays/maxBookingsPerUser), missing
-- index (Asset_categoryId_idx), and missing FK constraints on GroupResourceRole
-- that were omitted from earlier partial migration runs on some environments.
--
-- All statements are idempotent so this migration is safe to run against both
-- a fresh database (where migration 2 already added the GroupResourceRole FKs)
-- and a partially-migrated database (where those FKs were missing).

-- CreateEnum (idempotent via DO block)
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'AuthConfigProvider') THEN
    CREATE TYPE "AuthConfigProvider" AS ENUM ('OIDC', 'SAML', 'LDAP');
  END IF;
END $$;

-- AlterTable: Asset amenities default (DROP DEFAULT is a no-op if no default exists)
ALTER TABLE "Asset" ALTER COLUMN "amenities" DROP DEFAULT;

-- AlterTable: Organisation booking policy columns
ALTER TABLE "Organisation"
  ADD COLUMN IF NOT EXISTS "maxAdvanceBookingDays" INTEGER NOT NULL DEFAULT 14,
  ADD COLUMN IF NOT EXISTS "maxBookingsPerUser"    INTEGER NOT NULL DEFAULT 5;

-- CreateTable: AuthConfig
CREATE TABLE IF NOT EXISTS "AuthConfig" (
    "id"        TEXT NOT NULL,
    "provider"  "AuthConfigProvider" NOT NULL,
    "enabled"   BOOLEAN NOT NULL DEFAULT false,
    "config"    JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AuthConfig_pkey" PRIMARY KEY ("id")
);

-- CreateTable: BuildingLease
CREATE TABLE IF NOT EXISTS "BuildingLease" (
    "id"          TEXT NOT NULL,
    "buildingId"  TEXT NOT NULL,
    "name"        TEXT NOT NULL,
    "startDate"   TIMESTAMP(3) NOT NULL,
    "endDate"     TIMESTAMP(3),
    "landlord"    TEXT,
    "rentAmount"  DOUBLE PRECISION,
    "currency"    TEXT NOT NULL DEFAULT 'GBP',
    "notes"       TEXT,
    "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"   TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BuildingLease_pkey" PRIMARY KEY ("id")
);

-- CreateTable: LeaseDocument
CREATE TABLE IF NOT EXISTS "LeaseDocument" (
    "id"          TEXT NOT NULL,
    "leaseId"     TEXT NOT NULL,
    "filename"    TEXT NOT NULL,
    "storagePath" TEXT NOT NULL,
    "mimeType"    TEXT NOT NULL DEFAULT 'application/octet-stream',
    "sizeBytes"   INTEGER NOT NULL DEFAULT 0,
    "uploadedAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LeaseDocument_pkey" PRIMARY KEY ("id")
);

-- CreateIndex (all idempotent)
CREATE UNIQUE INDEX IF NOT EXISTS "AuthConfig_provider_key"    ON "AuthConfig"("provider");
CREATE INDEX        IF NOT EXISTS "BuildingLease_buildingId_idx" ON "BuildingLease"("buildingId");
CREATE INDEX        IF NOT EXISTS "LeaseDocument_leaseId_idx"   ON "LeaseDocument"("leaseId");
CREATE INDEX        IF NOT EXISTS "Asset_categoryId_idx"        ON "Asset"("categoryId");

-- AddForeignKey: BuildingLease → Building
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'BuildingLease_buildingId_fkey'
  ) THEN
    ALTER TABLE "BuildingLease" ADD CONSTRAINT "BuildingLease_buildingId_fkey"
      FOREIGN KEY ("buildingId") REFERENCES "Building"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

-- AddForeignKey: LeaseDocument → BuildingLease
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'LeaseDocument_leaseId_fkey'
  ) THEN
    ALTER TABLE "LeaseDocument" ADD CONSTRAINT "LeaseDocument_leaseId_fkey"
      FOREIGN KEY ("leaseId") REFERENCES "BuildingLease"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

-- AddForeignKey: GroupResourceRole → UserGroup (may already exist on fresh DBs)
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'GroupResourceRole_groupId_fkey'
  ) THEN
    ALTER TABLE "GroupResourceRole" ADD CONSTRAINT "GroupResourceRole_groupId_fkey"
      FOREIGN KEY ("groupId") REFERENCES "UserGroup"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

-- AddForeignKey: GroupResourceRole → Building (may already exist on fresh DBs)
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'GroupResourceRole_buildingId_fkey'
  ) THEN
    ALTER TABLE "GroupResourceRole" ADD CONSTRAINT "GroupResourceRole_buildingId_fkey"
      FOREIGN KEY ("buildingId") REFERENCES "Building"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

-- AddForeignKey: GroupResourceRole → Floor (may already exist on fresh DBs)
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'GroupResourceRole_floorId_fkey'
  ) THEN
    ALTER TABLE "GroupResourceRole" ADD CONSTRAINT "GroupResourceRole_floorId_fkey"
      FOREIGN KEY ("floorId") REFERENCES "Floor"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
