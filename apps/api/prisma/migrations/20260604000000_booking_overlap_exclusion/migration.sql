-- Durable backstop against double bookings.
--
-- Application code serialises booking creation per-asset with an advisory lock,
-- but that only protects paths that remember to take the lock. This exclusion
-- constraint makes the database itself refuse two CONFIRMED bookings whose time
-- ranges overlap for the same asset — regardless of which code path inserts them.
--
-- Requires btree_gist for the equality part of the GiST index on "assetId".
-- Booking timestamps are TIMESTAMP(3) (no time zone), so tsrange is used.
-- tsrange defaults to '[)' bounds, so back-to-back bookings (endsAt == next
-- startsAt) do not conflict — matching the application-level overlap check.
--
-- NOTE: if pre-existing overlapping CONFIRMED bookings exist this migration will
-- fail; resolve those rows before applying.

CREATE EXTENSION IF NOT EXISTS btree_gist;

ALTER TABLE "Booking"
  ADD CONSTRAINT "booking_no_overlap"
  EXCLUDE USING gist (
    "assetId" WITH =,
    tsrange("startsAt", "endsAt") WITH &&
  )
  WHERE (status = 'CONFIRMED');
