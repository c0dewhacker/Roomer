ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'FLOOR_AVAILABLE';

CREATE TABLE IF NOT EXISTS "FloorSubscription" (
  "id"             TEXT NOT NULL,
  "userId"         TEXT NOT NULL,
  "floorId"        TEXT NOT NULL,
  "lastNotifiedAt" TIMESTAMP(3),
  "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "FloorSubscription_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "FloorSubscription_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "FloorSubscription_floorId_fkey" FOREIGN KEY ("floorId") REFERENCES "Floor"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS "FloorSubscription_userId_floorId_key" ON "FloorSubscription"("userId", "floorId");
CREATE INDEX IF NOT EXISTS "FloorSubscription_userId_idx" ON "FloorSubscription"("userId");
CREATE INDEX IF NOT EXISTS "FloorSubscription_floorId_idx" ON "FloorSubscription"("floorId");

CREATE TABLE IF NOT EXISTS "FloorSubscriptionZone" (
  "subscriptionId" TEXT NOT NULL,
  "zoneId"         TEXT NOT NULL,
  CONSTRAINT "FloorSubscriptionZone_pkey" PRIMARY KEY ("subscriptionId", "zoneId"),
  CONSTRAINT "FloorSubscriptionZone_subscriptionId_fkey" FOREIGN KEY ("subscriptionId") REFERENCES "FloorSubscription"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "FloorSubscriptionZone_zoneId_fkey" FOREIGN KEY ("zoneId") REFERENCES "Zone"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX IF NOT EXISTS "FloorSubscriptionZone_zoneId_idx" ON "FloorSubscriptionZone"("zoneId");
