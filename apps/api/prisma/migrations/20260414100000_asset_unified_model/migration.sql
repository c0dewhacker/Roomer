-- ============================================================
-- Migration: Collapse Desk into Asset (unified asset model)
-- All desks become assets with isBookable=true.
-- DeskStatus becomes BookableStatus; DeskZone→AssetZone;
-- DeskAllowList→AssetAllowList; Booking.deskId→assetId;
-- QueueEntry.deskId→assetId.
--
-- BookableStatus enum and AssetStatus.DISABLED were added in the preceding
-- migration (20260413500000_add_bookable_status_enum) so they are already
-- committed before this migration runs.
-- ============================================================

-- ── 3. AssetCategory: new fields ─────────────────────────────────────────────
ALTER TABLE "AssetCategory"
  ADD COLUMN IF NOT EXISTS "defaultIsBookable" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "defaultIcon"       TEXT,
  ADD COLUMN IF NOT EXISTS "colour"            TEXT NOT NULL DEFAULT '#6366f1';

-- ── 4. Asset: new bookability + map-placement fields ─────────────────────────
ALTER TABLE "Asset"
  ADD COLUMN IF NOT EXISTS "isBookable"    BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "bookingLabel"  TEXT,
  ADD COLUMN IF NOT EXISTS "amenities"     TEXT[]  NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS "bookingStatus" "BookableStatus",
  ADD COLUMN IF NOT EXISTS "primaryZoneId" TEXT,
  ADD COLUMN IF NOT EXISTS "floorId"       TEXT,
  ADD COLUMN IF NOT EXISTS "x"             DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS "y"             DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS "width"         DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS "height"        DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS "rotation"      DOUBLE PRECISION;

-- FK: Asset → Zone (primary zone)
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'Asset_primaryZoneId_fkey'
  ) THEN
    ALTER TABLE "Asset"
      ADD CONSTRAINT "Asset_primaryZoneId_fkey"
      FOREIGN KEY ("primaryZoneId") REFERENCES "Zone"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

-- FK: Asset → Floor
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'Asset_floorId_fkey'
  ) THEN
    ALTER TABLE "Asset"
      ADD CONSTRAINT "Asset_floorId_fkey"
      FOREIGN KEY ("floorId") REFERENCES "Floor"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

-- Indexes for the new Asset columns
CREATE INDEX IF NOT EXISTS "Asset_floorId_idx"      ON "Asset"("floorId");
CREATE INDEX IF NOT EXISTS "Asset_primaryZoneId_idx" ON "Asset"("primaryZoneId");
CREATE INDEX IF NOT EXISTS "Asset_isBookable_idx"   ON "Asset"("isBookable");

-- ── 5. Create AssetZone table ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "AssetZone" (
    "assetId"   TEXT NOT NULL,
    "zoneId"    TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AssetZone_pkey" PRIMARY KEY ("assetId", "zoneId")
);
CREATE INDEX IF NOT EXISTS "AssetZone_assetId_idx" ON "AssetZone"("assetId");
CREATE INDEX IF NOT EXISTS "AssetZone_zoneId_idx"  ON "AssetZone"("zoneId");
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'AssetZone_assetId_fkey'
  ) THEN
    ALTER TABLE "AssetZone"
      ADD CONSTRAINT "AssetZone_assetId_fkey"
      FOREIGN KEY ("assetId") REFERENCES "Asset"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'AssetZone_zoneId_fkey'
  ) THEN
    ALTER TABLE "AssetZone"
      ADD CONSTRAINT "AssetZone_zoneId_fkey"
      FOREIGN KEY ("zoneId") REFERENCES "Zone"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

-- ── 6. Create AssetAllowList table ───────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "AssetAllowList" (
    "assetId"   TEXT NOT NULL,
    "userId"    TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AssetAllowList_pkey" PRIMARY KEY ("assetId", "userId")
);
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'AssetAllowList_assetId_fkey'
  ) THEN
    ALTER TABLE "AssetAllowList"
      ADD CONSTRAINT "AssetAllowList_assetId_fkey"
      FOREIGN KEY ("assetId") REFERENCES "Asset"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'AssetAllowList_userId_fkey'
  ) THEN
    ALTER TABLE "AssetAllowList"
      ADD CONSTRAINT "AssetAllowList_userId_fkey"
      FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

-- ── 6b. Create AssetUserAssignment table ─────────────────────────────────────
-- Tracks permanent desk→user assignments (primary/secondary ownership).
CREATE TABLE IF NOT EXISTS "AssetUserAssignment" (
    "assetId"   TEXT NOT NULL,
    "userId"    TEXT NOT NULL,
    "isPrimary" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AssetUserAssignment_pkey" PRIMARY KEY ("assetId", "userId")
);
CREATE INDEX IF NOT EXISTS "AssetUserAssignment_assetId_idx" ON "AssetUserAssignment"("assetId");
CREATE INDEX IF NOT EXISTS "AssetUserAssignment_userId_idx"  ON "AssetUserAssignment"("userId");
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'AssetUserAssignment_assetId_fkey'
  ) THEN
    ALTER TABLE "AssetUserAssignment"
      ADD CONSTRAINT "AssetUserAssignment_assetId_fkey"
      FOREIGN KEY ("assetId") REFERENCES "Asset"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'AssetUserAssignment_userId_fkey'
  ) THEN
    ALTER TABLE "AssetUserAssignment"
      ADD CONSTRAINT "AssetUserAssignment_userId_fkey"
      FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

-- ── 7. Upsert a default "Desk" category for migrated desks ───────────────────
INSERT INTO "AssetCategory" ("id", "name", "description", "defaultIsBookable", "defaultIcon", "colour", "createdAt")
VALUES (gen_random_uuid()::text, 'Desk', 'Standard bookable workspace', true, 'monitor', '#6366f1', NOW())
ON CONFLICT ("name") DO UPDATE
  SET "defaultIsBookable" = true,
      "defaultIcon"       = COALESCE("AssetCategory"."defaultIcon", 'monitor'),
      "colour"            = COALESCE(NULLIF("AssetCategory"."colour", ''), '#6366f1');

-- ── 8. Migrate Desk rows → Asset ─────────────────────────────────────────────
-- Desks that already have their id in Asset (shouldn't happen) are skipped.
INSERT INTO "Asset" (
    "id", "categoryId", "name",
    "status",
    "isBookable", "bookingStatus",
    "amenities",
    "primaryZoneId", "floorId",
    "x", "y", "width", "height", "rotation",
    "createdAt", "updatedAt"
)
SELECT
    d."id",
    (SELECT "id" FROM "AssetCategory" WHERE "name" = 'Desk' LIMIT 1),
    d."name",
    -- Map DeskStatus to AssetStatus
    CASE d."status"::text
        WHEN 'DISABLED'  THEN 'DISABLED'::"AssetStatus"
        WHEN 'ASSIGNED'  THEN 'ASSIGNED'::"AssetStatus"
        ELSE                  'AVAILABLE'::"AssetStatus"
    END,
    true,                              -- isBookable
    d."status"::text::"BookableStatus", -- bookingStatus mirrors DeskStatus
    COALESCE(d."amenities", '{}'),
    d."zoneId",                        -- primaryZoneId
    z."floorId",                       -- floorId from the zone's floor
    d."x", d."y", d."width", d."height", d."rotation",
    d."createdAt", d."updatedAt"
FROM "Desk" d
JOIN "Zone" z ON z."id" = d."zoneId"
ON CONFLICT ("id") DO NOTHING;

-- ── 9. Migrate DeskZone → AssetZone (conditional — DeskZone may not exist) ───
DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'DeskZone'
  ) THEN
    INSERT INTO "AssetZone" ("assetId", "zoneId", "createdAt")
    SELECT "deskId", "zoneId", "createdAt"
    FROM "DeskZone"
    ON CONFLICT DO NOTHING;
  END IF;
END $$;

-- ── 10. Migrate DeskAllowList → AssetAllowList ────────────────────────────────
INSERT INTO "AssetAllowList" ("assetId", "userId", "createdAt")
SELECT "deskId", "userId", "createdAt"
FROM "DeskAllowList"
ON CONFLICT DO NOTHING;

-- ── 11. Migrate DeskUserAssignment → AssetUserAssignment (conditional) ────────
DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'DeskUserAssignment'
  ) THEN
    INSERT INTO "AssetUserAssignment" ("assetId", "userId", "isPrimary", "createdAt")
    SELECT "deskId", "userId", "isPrimary", "createdAt"
    FROM "DeskUserAssignment"
    ON CONFLICT DO NOTHING;
  END IF;
END $$;

-- ── 12. Booking: rename deskId → assetId ─────────────────────────────────────
ALTER TABLE "Booking" ADD COLUMN IF NOT EXISTS "assetId" TEXT;
UPDATE "Booking" SET "assetId" = "deskId" WHERE "assetId" IS NULL AND "deskId" IS NOT NULL;
-- Ensure all rows are populated before adding NOT NULL constraint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'Booking' AND column_name = 'assetId') THEN
    ALTER TABLE "Booking" ALTER COLUMN "assetId" SET NOT NULL;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'Booking_assetId_fkey'
  ) THEN
    ALTER TABLE "Booking"
      ADD CONSTRAINT "Booking_assetId_fkey"
      FOREIGN KEY ("assetId") REFERENCES "Asset"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
-- Re-create index on assetId
DROP INDEX IF EXISTS "Booking_deskId_startsAt_endsAt_idx";
CREATE INDEX IF NOT EXISTS "Booking_assetId_startsAt_endsAt_idx" ON "Booking"("assetId", "startsAt", "endsAt");
-- Drop old FK and column
ALTER TABLE "Booking" DROP CONSTRAINT IF EXISTS "Booking_deskId_fkey";
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'Booking' AND column_name = 'deskId') THEN
    ALTER TABLE "Booking" DROP COLUMN "deskId";
  END IF;
END $$;

-- ── 13. QueueEntry: rename deskId → assetId ──────────────────────────────────
ALTER TABLE "QueueEntry" ADD COLUMN IF NOT EXISTS "assetId" TEXT;
UPDATE "QueueEntry" SET "assetId" = "deskId" WHERE "assetId" IS NULL AND "deskId" IS NOT NULL;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'QueueEntry' AND column_name = 'assetId') THEN
    ALTER TABLE "QueueEntry" ALTER COLUMN "assetId" SET NOT NULL;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'QueueEntry_assetId_fkey'
  ) THEN
    ALTER TABLE "QueueEntry"
      ADD CONSTRAINT "QueueEntry_assetId_fkey"
      FOREIGN KEY ("assetId") REFERENCES "Asset"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
DROP INDEX IF EXISTS "QueueEntry_deskId_status_wantedStartsAt_wantedEndsAt_idx";
CREATE INDEX IF NOT EXISTS "QueueEntry_assetId_status_wantedStartsAt_wantedEndsAt_idx"
  ON "QueueEntry"("assetId", "status", "wantedStartsAt", "wantedEndsAt");
ALTER TABLE "QueueEntry" DROP CONSTRAINT IF EXISTS "QueueEntry_deskId_fkey";
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'QueueEntry' AND column_name = 'deskId') THEN
    ALTER TABLE "QueueEntry" DROP COLUMN "deskId";
  END IF;
END $$;

-- ── 14. AssetAssignment: remove desk-related columns ─────────────────────────
-- Delete any DESK-type assignments (no longer meaningful)
DELETE FROM "AssetAssignment" WHERE "assigneeType" = 'DESK';
ALTER TABLE "AssetAssignment" DROP COLUMN IF EXISTS "deskId";
ALTER TABLE "AssetAssignment" DROP COLUMN IF EXISTS "assigneeType";

-- ── 15. Drop old Desk-related tables (order: dependents first) ────────────────
DROP TABLE IF EXISTS "DeskAllowList";
DROP TABLE IF EXISTS "DeskZone";
DROP TABLE IF EXISTS "DeskUserAssignment";
DROP TABLE IF EXISTS "Desk";

-- ── 16. Drop old enum types ───────────────────────────────────────────────────
DROP TYPE IF EXISTS "DeskStatus";
DROP TYPE IF EXISTS "AssetAssigneeType";
