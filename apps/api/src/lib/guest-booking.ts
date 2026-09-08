import { env } from '../env.js'
import { buildBookingIcs } from './ical.js'
import { sendEmail, renderGuestBookingInvite } from './mailer.js'

/**
 * Emails the guest a check-in link once their booking is actually CONFIRMED
 * (immediately on creation, or later via POST /:id/approve if the zone
 * requires approval) — sent directly via sendEmail rather than through
 * enqueueNotification/Notification, since a guest has no User row to key a
 * Notification on or an in-app bell to show it in.
 *
 * Includes an .ics REQUEST attachment, same as the host's own confirmation
 * email — a guest's "you're booked in" email is a confirmation email, and
 * without a calendar payload their calendar app never actually gets the
 * event. A reschedule resend reuses the same id/UID with the booking's
 * current (already-bumped) icsSequence, so the recipient's calendar app
 * recognises it as an update to the existing event rather than a duplicate.
 */
export async function sendGuestBookingInvite(booking: {
  id: string
  startsAt: Date
  endsAt: Date
  guestName: string
  guestEmail: string
  guestCheckInToken: string
  icsSequence: number
}, hostDisplayName: string, asset: { name: string; primaryZone?: { name: string } | null; floor?: { name: string; building?: { name: string } | null } | null }, timeZone = 'UTC'): Promise<void> {
  const checkInUrl = `${env.APP_URL}/guest-check-in?token=${encodeURIComponent(booking.guestCheckInToken)}`
  const payload = renderGuestBookingInvite(
    booking.guestName,
    { displayName: hostDisplayName },
    booking,
    { name: asset.name, zoneName: asset.primaryZone?.name, floorName: asset.floor?.name, buildingName: asset.floor?.building?.name },
    checkInUrl,
    timeZone,
  )
  const icalEvent = {
    method: 'REQUEST',
    content: buildBookingIcs({
      id: booking.id, startsAt: booking.startsAt, endsAt: booking.endsAt,
      assetName: asset.name, zoneName: asset.primaryZone?.name, floorName: asset.floor?.name, buildingName: asset.floor?.building?.name,
      sequence: booking.icsSequence,
      attendeeEmail: booking.guestEmail, attendeeName: booking.guestName,
      // A guest has no account and can't load the default {APP_URL}/bookings/:id
      // link — point the calendar entry at their check-in link instead, the
      // one URL they can actually use.
      url: checkInUrl,
    }, 'REQUEST'),
  }
  await sendEmail({ to: booking.guestEmail, ...payload, icalEvent }).catch(() => {})
}
