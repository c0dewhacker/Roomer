-- Add BookableStatus enum and DISABLED value to AssetStatus.
-- These must be committed in their own transaction before any migration
-- that uses the new values (PostgreSQL restriction on new enum values).

CREATE TYPE "BookableStatus" AS ENUM ('OPEN', 'RESTRICTED', 'ASSIGNED', 'DISABLED');

ALTER TYPE "AssetStatus" ADD VALUE 'DISABLED';
