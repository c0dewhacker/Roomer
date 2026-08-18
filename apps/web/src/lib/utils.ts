import { type ClassValue, clsx } from 'clsx'
import { twMerge } from 'tailwind-merge'
import { format, formatDistance } from 'date-fns'
import { getDateFormat } from './dateFormat'

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

export function formatDate(date: Date | string): string {
  const d = typeof date === 'string' ? new Date(date) : date
  return format(d, getDateFormat())
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

export function formatDateTime(date: Date | string): string {
  const d = typeof date === 'string' ? new Date(date) : date
  return `${format(d, getDateFormat())} · ${format(d, 'HH:mm')}`
}

export function formatDateRange(start: Date | string, end: Date | string): string {
  const s = typeof start === 'string' ? new Date(start) : start
  const e = typeof end === 'string' ? new Date(end) : end
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

export function toISODateString(date: Date): string {
  return format(date, 'yyyy-MM-dd')
}
