import { type ClassValue, clsx } from 'clsx'
import { twMerge } from 'tailwind-merge'
import { format, formatDistance } from 'date-fns'
import { toZonedTime } from 'date-fns-tz'
import { getDateFormat } from './dateFormat'

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

/**
 * When `timeZone` is given (a booking's resolved building timezone — see
 * #72), converts to that zone's wall-clock before formatting, so a booking
 * displays the same time everywhere regardless of which timezone the
 * viewer's own browser happens to be in — the whole point of anchoring
 * booking creation to the building's timezone in the first place. Omitted
 * (the default for call sites with no per-booking timezone available, e.g.
 * a lease date or a generic date picker) falls back to the browser's own
 * local time, unchanged from before.
 */
function zoned(d: Date, timeZone?: string): Date {
  return timeZone ? toZonedTime(d, timeZone) : d
}

export function formatDate(date: Date | string, timeZone?: string): string {
  const d = typeof date === 'string' ? new Date(date) : date
  return format(zoned(d, timeZone), getDateFormat())
}

/**
 * Format a pure calendar-date field (no meaningful time-of-day) stored as
 * UTC midnight of the day an admin picked — e.g. RecurringBookingRule's
 * firstDate/lastDate, BuildingLease's startDate/endDate. formatDate()
 * correctly converts real timestamps to the viewer's local time, but doing
 * that here shifts the date itself backwards by a day for anyone behind
 * UTC (e.g. 2026-08-25T00:00:00Z renders as "24/08/2026" at UTC-10) since
 * there's no real instant to convert, only a calendar day. Re-anchors the
 * UTC components as local midnight first, same fix already applied to
 * LeasesAdminPage's expiry countdown.
 */
export function formatCalendarDate(date: Date | string): string {
  const d = typeof date === 'string' ? new Date(date) : date
  const localMidnight = new Date(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())
  return format(localMidnight, getDateFormat())
}

export function formatDateTime(date: Date | string, timeZone?: string): string {
  const d = zoned(typeof date === 'string' ? new Date(date) : date, timeZone)
  return `${format(d, getDateFormat())} · ${format(d, 'HH:mm')}`
}

export function formatDateRange(start: Date | string, end: Date | string, timeZone?: string): string {
  const s = zoned(typeof start === 'string' ? new Date(start) : start, timeZone)
  const e = zoned(typeof end === 'string' ? new Date(end) : end, timeZone)
  const sameDay = format(s, 'yyyy-MM-dd') === format(e, 'yyyy-MM-dd')
  if (sameDay) {
    return `${format(s, getDateFormat())} · ${format(s, 'HH:mm')} – ${format(e, 'HH:mm')}`
  }
  return `${format(s, getDateFormat())} ${format(s, 'HH:mm')} – ${format(e, getDateFormat())} ${format(e, 'HH:mm')}`
}

export function formatRelative(date: Date | string): string {
  const d = typeof date === 'string' ? new Date(date) : date
  return formatDistance(d, new Date(), { addSuffix: true })
}

const browserTimeZone = Intl.DateTimeFormat().resolvedOptions().timeZone

/**
 * A short qualifier ("AEST", "GMT+10") to append after a formatted booking
 * time, but ONLY when `timeZone` (the booking's resolved building timezone —
 * see #72) differs from the viewer's own browser timezone. A remote admin
 * looking at a booking in another office's timezone needs to know the shown
 * time isn't their own local time; anyone in the same timezone as the
 * building (the common case) sees no extra clutter at all.
 */
export function zoneQualifier(timeZone: string | undefined, date: Date | string): string | null {
  if (!timeZone || timeZone === browserTimeZone) return null
  const d = typeof date === 'string' ? new Date(date) : date
  const parts = new Intl.DateTimeFormat('en', { timeZone, timeZoneName: 'short' }).formatToParts(d)
  return parts.find((p) => p.type === 'timeZoneName')?.value ?? timeZone
}

export function toISODateString(date: Date): string {
  return format(date, 'yyyy-MM-dd')
}
