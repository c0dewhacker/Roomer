-- ============================================================
-- Migration: Collapse Desk into Asset (unified asset model)
-- All desks become assets with isBookable=true.
-- DeskStatus becomes BookableStatus; DeskZone→AssetZone;
-- DeskAllowList→AssetAllowList; Booking.deskId→assetId;
-- QueueEntry.deskId→assetId.
-- ============================================================

-- ── 1. New enum BookableStatus and DISABLED on AssetStatus were applied in a
--       separate transaction before this file (enum values need their own txn).

-- ── 3. AssetCategory: new fields ─────────────────────────────────────────────
ALTER TABLE "AssetCategory"
  ADD COLUMN "defaultIsBookable" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "defaultIcon"       TEXT,
  ADD COLUMN "colour"            TEXT NOT NULL DEFAULT '#6366f1';

-- ── 4. Asset: new bookability + map-placement fields ─────────────────────────
ALTER TABLE "Asset"
  ADD COLUMN "isBookable"    BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "bookingLabel"  TEXT,
  ADD COLUMN "amenities"     TEXT[]  NOT NULL DEFAULT '{}',
  ADD COLUMN "bookingStatus" "BookableStatus",
  ADD COLUMN "primaryZoneId" TEXT,
  ADD COLUMN "floorId"       TEXT,
  ADD COLUMN "x"             DOUBLE PRECISION,
  ADD COLUMN "y"             DOUBLE PRECISION,
  ADD COLUMN "width"         DOUBLE PRECISION,
  ADD COLUMN "height"        DOUBLE PRECISION,
  ADD COLUMN "rotation"      DOUBLE PRECISION;

-- FK: Asset → Zone (primary zone)
ALTER TABLE "Asset"
  ADD CONSTRAINT "Asset_primaryZoneId_fkey"
  FOREIGN KEY ("primaryZoneId") REFERENCES "Zone"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

-- FK: Asset → Floor
ALTER TABLE "Asset"
  ADD CONSTRAINT "Asset_floorId_fkey"
  FOREIGN KEY ("floorId") REFERENCES "Floor"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

-- Indexes for the new Asset columns
CREATE INDEX "Asset_floorId_idx"      ON "Asset"("floorId");
CREATE INDEX "Asset_primaryZoneId_idx" ON "Asset"("primaryZoneId");
CREATE INDEX "Asset_isBookable_idx"   ON "Asset"("isBookable");

-- ── 5. Create AssetZone table ─────────────────────────────────────────────────
CREATE TABLE "AssetZone" (
    "assetId"   TEXT NOT NULL,
    "zoneId"    TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AssetZone_pkey" PRIMARY KEY ("assetId", "zoneId")
);
CREATE INDEX "AssetZone_assetId_idx" ON "AssetZone"("assetId");
CREATE INDEX "AssetZone_zoneId_idx"  ON "AssetZone"("zoneId");
ALTER TABLE "AssetZone"
  ADD CONSTRAINT "AssetZone_assetId_fkey"
  FOREIGN KEY ("assetId") REFERENCES "Asset"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AssetZone"
  ADD CONSTRAINT "AssetZone_zoneId_fkey"
  FOREIGN KEY ("zoneId") REFERENCES "Zone"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ── 6. Create AssetAllowList table ───────────────────────────────────────────
CREATE TABLE "AssetAllowList" (
    "assetId"   TEXT NOT NULL,
    "userId"    TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AssetAllowList_pkey" PRIMARY KEY ("assetId", "userId")
);
ALTER TABLE "AssetAllowList"
  ADD CONSTRAINT "AssetAllowList_assetId_fkey"
  FOREIGN KEY ("assetId") REFERENCES "Asset"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AssetAllowList"
  ADD CONSTRAINT "AssetAllowList_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

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
    d."amenities",
    d."zoneId",                        -- primaryZoneId
    z."floorId",                       -- floorId from the zone's floor
    d."x", d."y", d."width", d."height", d."rotation",
    d."createdAt", d."updatedAt"
FROM "Desk" d
JOIN "Zone" z ON z."id" = d."zoneId"
ON CONFLICT ("id") DO NOTHING;

-- ── 9. Migrate DeskZone → AssetZone ──────────────────────────────────────────
INSERT INTO "AssetZone" ("assetId", "zoneId", "createdAt")
SELECT "deskId", "zoneId", "createdAt"
FROM "DeskZone"
ON CONFLICT DO NOTHING;

-- ── 10. Migrate DeskAllowList → AssetAllowList ────────────────────────────────
INSERT INTO "AssetAllowList" ("assetId", "userId", "createdAt")
SELECT "deskId", "userId", "createdAt"
FROM "DeskAllowList"
ON CONFLICT DO NOTHING;

-- ── 11. Migrate DeskUserAssignment → AssetUserAssignment ─────────────────────
INSERT INTO "AssetUserAssignment" ("assetId", "userId", "isPrimary", "createdAt")
SELECT "deskId", "userId", "isPrimary", "createdAt"
FROM "DeskUserAssignment"
ON CONFLICT DO NOTHING;

-- ── 12. Booking: rename deskId → assetId ─────────────────────────────────────
ALTER TABLE "Booking" ADD COLUMN "assetId" TEXT;
UPDATE "Booking" SET "assetId" = "deskId";
-- Ensure all rows are populated before adding NOT NULL constraint
ALTER TABLE "Booking" ALTER COLUMN "assetId" SET NOT NULL;
ALTER TABLE "Booking"
  ADD CONSTRAINT "Booking_assetId_fkey"
  FOREIGN KEY ("assetId") REFERENCES "Asset"("id") ON DELETE CASCADE ON UPDATE CASCADE;
-- Re-create index on assetId
DROP INDEX IF EXISTS "Booking_deskId_startsAt_endsAt_idx";
CREATE INDEX "Booking_assetId_startsAt_endsAt_idx" ON "Booking"("assetId", "startsAt", "endsAt");
-- Drop old FK and column
ALTER TABLE "Booking" DROP CONSTRAINT IF EXISTS "Booking_deskId_fkey";
ALTER TABLE "Booking" DROP COLUMN "deskId";

-- ── 13. QueueEntry: rename deskId → assetId ──────────────────────────────────
ALTER TABLE "QueueEntry" ADD COLUMN "assetId" TEXT;
UPDATE "QueueEntry" SET "assetId" = "deskId";
ALTER TABLE "QueueEntry" ALTER COLUMN "assetId" SET NOT NULL;
ALTER TABLE "QueueEntry"
  ADD CONSTRAINT "QueueEntry_assetId_fkey"
  FOREIGN KEY ("assetId") REFERENCES "Asset"("id") ON DELETE CASCADE ON UPDATE CASCADE;
DROP INDEX IF EXISTS "QueueEntry_deskId_status_wantedStartsAt_wantedEndsAt_idx";
CREATE INDEX "QueueEntry_assetId_status_wantedStartsAt_wantedEndsAt_idx"
  ON "QueueEntry"("assetId", "status", "wantedStartsAt", "wantedEndsAt");
ALTER TABLE "QueueEntry" DROP CONSTRAINT IF EXISTS "QueueEntry_deskId_fkey";
ALTER TABLE "QueueEntry" DROP COLUMN "deskId";

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
