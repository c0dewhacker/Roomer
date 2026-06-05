import { env } from '../env.js'

export type IcalMethod = 'REQUEST' | 'CANCEL' | 'PUBLISH'

/** Format a Date as an iCalendar UTC timestamp: YYYYMMDDTHHMMSSZ */
function toIcsUtc(d: Date): string {
  return d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '')
}

/** Escape a text value per RFC 5545 (commas, semicolons, backslashes, newlines). */
function escapeText(s: string): string {
  return s
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r?\n/g, '\\n')
}

/** Fold a content line to <=75 octets per RFC 5545 (continuation lines start with a space). */
function foldLine(line: string): string {
  if (line.length <= 75) return line
  const parts: string[] = []
  let rest = line
  parts.push(rest.slice(0, 75))
  rest = rest.slice(75)
  while (rest.length > 74) {
    parts.push(' ' + rest.slice(0, 74))
    rest = rest.slice(74)
  }
  if (rest.length) parts.push(' ' + rest)
  return parts.join('\r\n')
}

export interface BookingIcsInput {
  id: string
  startsAt: Date
  endsAt: Date
  assetName: string
  zoneName?: string | null
  floorName?: string | null
  buildingName?: string | null
}

/**
 * Build an iCalendar (.ics) document for a desk booking.
 *  - method REQUEST  → an invite for the confirmation email
 *  - method CANCEL   → a cancellation (same UID, bumped SEQUENCE) so the event
 *                      is removed from the user's calendar
 */
export function buildBookingIcs(booking: BookingIcsInput, method: IcalMethod = 'REQUEST'): string {
  const uid = `booking-${booking.id}@roomer`
  const location = [booking.assetName, booking.zoneName, booking.floorName, booking.buildingName]
    .filter(Boolean)
    .join(', ')
  const isCancel = method === 'CANCEL'
  const summary = `${isCancel ? 'Cancelled: ' : ''}Desk booking — ${booking.assetName}`
  const description = `Your Roomer desk booking for ${booking.assetName}.`

  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Roomer//Desk Booking//EN',
    'CALSCALE:GREGORIAN',
    `METHOD:${method}`,
    'BEGIN:VEVENT',
    `UID:${uid}`,
    `SEQUENCE:${isCancel ? 1 : 0}`,
    `DTSTAMP:${toIcsUtc(new Date())}`,
    `DTSTART:${toIcsUtc(booking.startsAt)}`,
    `DTEND:${toIcsUtc(booking.endsAt)}`,
    `SUMMARY:${escapeText(summary)}`,
    location ? `LOCATION:${escapeText(location)}` : '',
    `DESCRIPTION:${escapeText(description)}`,
    `URL:${env.APP_URL}/bookings/${booking.id}`,
    `STATUS:${isCancel ? 'CANCELLED' : 'CONFIRMED'}`,
    'END:VEVENT',
    'END:VCALENDAR',
  ].filter(Boolean)

  return lines.map(foldLine).join('\r\n') + '\r\n'
}
