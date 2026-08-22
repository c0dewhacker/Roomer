import { env } from '../env.js'

export type IcalMethod = 'REQUEST' | 'CANCEL' | 'PUBLISH'

/** Format a Date as an iCalendar UTC timestamp: YYYYMMDDTHHMMSSZ */
function toIcsUtc(d: Date): string {
  return d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '')
}

/**
 * Escape a text value per RFC 5545 (commas, semicolons, backslashes,
 * newlines). Matches `\r\n`, a lone `\n`, AND a lone `\r` — a bare
 * carriage return with no trailing `\n` previously passed through
 * unescaped, and some calendar clients treat a lone CR as a line
 * terminator while unfolding, which would let a crafted field (an asset/
 * zone/floor/building name — none of the corresponding schemas restrict
 * these to newline-free strings) inject an extra property line into the
 * generated invite.
 */
function escapeText(s: string): string {
  return s
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r\n|\r|\n/g, '\\n')
}

/**
 * Fold a content line to <=75 *octets* per RFC 5545 (continuation lines
 * start with a space). Operates on the UTF-8 byte representation, not JS
 * string length (UTF-16 code units) — a name with any non-ASCII character
 * (an accented building/asset name, an emoji) has a UTF-8 byte length
 * longer than its JS .length, so a naive character-based fold both violates
 * the 75-octet limit anyway AND risks slicing through the middle of a
 * multi-byte character or a surrogate pair, corrupting it into a stray
 * replacement character when the string is later encoded to bytes for the
 * SMTP body.
 */
function foldLine(line: string): string {
  const bytes = Buffer.from(line, 'utf8')
  if (bytes.length <= 75) return line
  const parts: string[] = []
  let offset = 0
  parts.push(sliceUtf8Safe(bytes, offset, 75))
  offset += Buffer.byteLength(parts[0], 'utf8')
  while (bytes.length - offset > 74) {
    const chunk = sliceUtf8Safe(bytes, offset, 74)
    parts.push(' ' + chunk)
    offset += Buffer.byteLength(chunk, 'utf8')
  }
  if (offset < bytes.length) parts.push(' ' + bytes.subarray(offset).toString('utf8'))
  return parts.join('\r\n')
}

/** Take up to `maxBytes` UTF-8 bytes from `bytes` starting at `offset`, backing off until the cut doesn't split a multi-byte character. */
function sliceUtf8Safe(bytes: Buffer, offset: number, maxBytes: number): string {
  let len = Math.min(maxBytes, bytes.length - offset)
  while (len > 0) {
    const slice = bytes.subarray(offset, offset + len)
    // A truncated multi-byte UTF-8 sequence decodes to U+FFFD at the end —
    // back off one byte and retry until the cut lands on a boundary.
    if (!slice.toString('utf8').endsWith('�')) return slice.toString('utf8')
    len--
  }
  return ''
}

/** Wrap a parameter value (e.g. ORGANIZER/ATTENDEE's CN) in quotes if it contains a character that requires it; strips DQUOTE, which RFC 5545 param-values can never contain even when quoted. */
function paramValue(s: string): string {
  const clean = s.replace(/"/g, '').replace(/\r\n|\r|\n/g, ' ')
  return /[:;,]/.test(clean) ? `"${clean}"` : clean
}

export interface BookingIcsInput {
  id: string
  startsAt: Date
  endsAt: Date
  assetName: string
  zoneName?: string | null
  floorName?: string | null
  buildingName?: string | null
  /**
   * RFC 5546 SEQUENCE. A REQUEST must pass the booking's current
   * Booking.icsSequence; a CANCEL must pass a value higher than whatever
   * REQUEST was last sent (icsSequence + 1) so calendar clients that key off
   * SEQUENCE rather than DTSTAMP accept it as superseding the invite, and a
   * re-sent REQUEST after a reschedule is recognised as an update rather
   * than an already-seen duplicate.
   */
  sequence: number
  /** The invite's recipient — required for ATTENDEE. Some clients (Outlook
   * especially) use ORGANIZER/ATTENDEE identity to decide whether an
   * incoming CANCEL is even allowed to remove an existing event. */
  attendeeEmail: string
  attendeeName?: string | null
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
    `SEQUENCE:${booking.sequence}`,
    `DTSTAMP:${toIcsUtc(new Date())}`,
    `DTSTART:${toIcsUtc(booking.startsAt)}`,
    `DTEND:${toIcsUtc(booking.endsAt)}`,
    `SUMMARY:${escapeText(summary)}`,
    location ? `LOCATION:${escapeText(location)}` : '',
    `DESCRIPTION:${escapeText(description)}`,
    `URL:${env.APP_URL}/bookings/${booking.id}`,
    `STATUS:${isCancel ? 'CANCELLED' : 'CONFIRMED'}`,
    // REQUEST/CANCEL are iTIP scheduling methods (RFC 5546) that require an
    // ORGANIZER — several clients (Outlook especially) use its identity,
    // matched against ATTENDEE, to decide whether an incoming CANCEL is even
    // allowed to remove an event it didn't see the matching REQUEST for.
    `ORGANIZER;CN=${paramValue('Roomer')}:mailto:${env.EMAIL_FROM}`,
    `ATTENDEE;CN=${paramValue(booking.attendeeName ?? booking.attendeeEmail)};PARTSTAT=${isCancel ? 'DECLINED' : 'ACCEPTED'}:mailto:${booking.attendeeEmail}`,
    'END:VEVENT',
    'END:VCALENDAR',
  ].filter(Boolean)

  return lines.map(foldLine).join('\r\n') + '\r\n'
}
