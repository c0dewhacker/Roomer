-- Recurring weekday availability for permanently-assigned assets.
-- An assigned user marks the weekdays their desk is always open to others.

CREATE TABLE "AssetAvailabilityRule" (
    "id" TEXT NOT NULL,
    "assetId" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "weekday" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AssetAvailabilityRule_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "AssetAvailabilityRule_assetId_weekday_key" ON "AssetAvailabilityRule"("assetId","weekday");
CREATE INDEX "AssetAvailabilityRule_assetId_idx" ON "AssetAvailabilityRule"("assetId");
CREATE INDEX "AssetAvailabilityRule_ownerId_idx" ON "AssetAvailabilityRule"("ownerId");

ALTER TABLE "AssetAvailabilityRule"
    ADD CONSTRAINT "AssetAvailabilityRule_assetId_fkey"
    FOREIGN KEY ("assetId") REFERENCES "Asset"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AssetAvailabilityRule"
    ADD CONSTRAINT "AssetAvailabilityRule_ownerId_fkey"
    FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
