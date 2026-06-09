-- Favourite assets: a user's starred assets for quick access in the booking flow.

CREATE TABLE "UserFavouriteAsset" (
    "userId" TEXT NOT NULL,
    "assetId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "UserFavouriteAsset_pkey" PRIMARY KEY ("userId","assetId")
);

CREATE INDEX "UserFavouriteAsset_userId_idx" ON "UserFavouriteAsset"("userId");
CREATE INDEX "UserFavouriteAsset_assetId_idx" ON "UserFavouriteAsset"("assetId");

ALTER TABLE "UserFavouriteAsset"
    ADD CONSTRAINT "UserFavouriteAsset_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "UserFavouriteAsset"
    ADD CONSTRAINT "UserFavouriteAsset_assetId_fkey"
    FOREIGN KEY ("assetId") REFERENCES "Asset"("id") ON DELETE CASCADE ON UPDATE CASCADE;
