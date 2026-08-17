-- Tracks when a user's passwordHash last changed so requireAuth can reject
-- access tokens issued before that point, invalidating other live sessions
-- (and any stolen token) immediately on password change instead of leaving
-- them valid until their own expiry.
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "passwordChangedAt" TIMESTAMP(3);
