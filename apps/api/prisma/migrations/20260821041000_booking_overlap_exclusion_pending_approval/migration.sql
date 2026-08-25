-- Booking approval workflow: a PENDING_APPROVAL booking now reserves the slot
-- immediately (same as CONFIRMED), so the double-booking exclusion constraint
-- must also block overlaps against pending-approval bookings, not just
-- confirmed ones.

ALTER TABLE "Booking" DROP CONSTRAINT "booking_no_overlap";

ALTER TABLE "Booking"
  ADD CONSTRAINT "booking_no_overlap"
  EXCLUDE USING gist (
    "assetId" WITH =,
    tsrange("startsAt", "endsAt") WITH &&
  )
  WHERE (status IN ('CONFIRMED', 'PENDING_APPROVAL'));
