-- Add branding column to Organisation
ALTER TABLE "Organisation" ADD COLUMN "branding" JSONB NOT NULL DEFAULT '{}';
