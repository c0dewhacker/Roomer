-- Remove the dead ASSET_DUE_RETURN notification type (see issue #200).
-- The feature it depended on (a due date on an equipment assignment) never
-- existed, and the model that would have carried one (AssetAssignment) was
-- already removed as dead code resolving #201 — nothing ever enqueued,
-- handled, or sent this type. The user-facing preference toggle that
-- controlled it was already removed in an earlier commit; this finishes the
-- cleanup by dropping the now-fully-unused enum value itself.
ALTER TYPE "NotificationType" RENAME TO "NotificationType_old";
CREATE TYPE "NotificationType" AS ENUM ('BOOKING_CONFIRMED', 'BOOKING_CANCELLED', 'BOOKING_CANCELLED_BY_ADMIN', 'BOOKING_NO_SHOW', 'BOOKING_REMINDER', 'QUEUE_JOINED', 'QUEUE_PROMOTED', 'QUEUE_EXPIRED', 'QUEUE_CLAIM_EXPIRING', 'ASSET_ASSIGNED', 'WELCOME', 'FLOOR_AVAILABLE');
ALTER TABLE "Notification" ALTER COLUMN "type" TYPE "NotificationType" USING ("type"::text::"NotificationType");
DROP TYPE "NotificationType_old";
