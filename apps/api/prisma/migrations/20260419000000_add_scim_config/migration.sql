-- Add ScimConfig table for SCIM 2.0 provisioning token management
CREATE TABLE "ScimConfig" (
    "id"        TEXT NOT NULL,
    "enabled"   BOOLEAN NOT NULL DEFAULT false,
    "tokenHash" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "ScimConfig_pkey" PRIMARY KEY ("id")
);
