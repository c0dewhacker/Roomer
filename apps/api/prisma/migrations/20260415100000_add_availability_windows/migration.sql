-- Add AssetAvailabilityWindow table
CREATE TABLE "AssetAvailabilityWindow" (
  "id"        TEXT NOT NULL,
  "assetId"   TEXT NOT NULL,
  "ownerId"   TEXT NOT NULL,
  "startsAt"  TIMESTAMP(3) NOT NULL,
  "endsAt"    TIMESTAMP(3) NOT NULL,
  "note"      TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "AssetAvailabilityWindow_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "AssetAvailabilityWindow_assetId_startsAt_endsAt_idx" ON "AssetAvailabilityWindow"("assetId", "startsAt", "endsAt");
CREATE INDEX "AssetAvailabilityWindow_ownerId_idx" ON "AssetAvailabilityWindow"("ownerId");

ALTER TABLE "AssetAvailabilityWindow"
  ADD CONSTRAINT "AssetAvailabilityWindow_assetId_fkey"
  FOREIGN KEY ("assetId") REFERENCES "Asset"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "AssetAvailabilityWindow"
  ADD CONSTRAINT "AssetAvailabilityWindow_ownerId_fkey"
  FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
