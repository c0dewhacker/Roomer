import type { Prisma } from '@prisma/client'
import { fromZonedTime, toZonedTime } from 'date-fns-tz'

/**
 * Resolve the IANA timezone that applies to this building: its own override
 * (Building.timezone) falling back to the org-wide default
 * (Organisation.defaultTimezone, itself defaulting to 'UTC') — see #72.
 * Bookings are always stored in UTC; this only affects display and the
 * working-hours/recurring-slot calculations below. Takes a `client` (rather
 * than importing the singleton `prisma`) so callers already inside a
 * transaction — assertBookable, recurring series creation — read a
 * consistent view, mirroring resolveRequiresApproval's (#74) pattern.
 */
export async function resolveBuildingTimezone(client: Prisma.TransactionClient, buildingId: string | null | undefined): Promise<string> {
  if (!buildingId) {
    const org = await client.organisation.findFirst({ select: { defaultTimezone: true } })
    return org?.defaultTimezone ?? 'UTC'
  }
  const building = await client.building.findUnique({ where: { id: buildingId }, select: { timezone: true } })
  if (building?.timezone) return building.timezone
  const org = await client.organisation.findFirst({ select: { defaultTimezone: true } })
  return org?.defaultTimezone ?? 'UTC'
}

/**
 * Calendar-day difference between a date-only value (UTC midnight of the
 * calendar day an admin picked, e.g. BuildingLease.endDate — read via its UTC
 * getters directly, since it has no real instant meaning of its own) and
 * "now" as it currently reads in `timeZone`. Comparing such a value as a raw
 * instant against `now` flips it a day early/late depending on the
 * building's UTC offset — up to ~14 hours early in any positive-offset
 * timezone, a day early in a negative-offset one. Mirrors
 * LeasesAdminPage.tsx's daysUntilLeaseExpiry, which carries the same fix on
 * the frontend anchored to the browser's local timezone instead — the
 * sensible server-side equivalent, since there's no "current user" to anchor
 * to here. Shared by the lease-expiry cron (queue.ts) and the admin-facing
 * lease update endpoint (routes/leases.ts), which both need to classify a
 * lease's endDate against "today" in the lease's own building's timezone.
 */
export function calendarDaysUntil(endDateUtcMidnight: Date, now: Date, timeZone: string): number {
  const endMs = Date.UTC(endDateUtcMidnight.getUTCFullYear(), endDateUtcMidnight.getUTCMonth(), endDateUtcMidnight.getUTCDate())
  const zonedNow = toZonedTime(now, timeZone)
  const nowMs = Date.UTC(zonedNow.getFullYear(), zonedNow.getMonth(), zonedNow.getDate())
  return Math.round((endMs - nowMs) / (24 * 60 * 60 * 1000))
}

/**
 * A real instant (e.g. a booking's startsAt) as a YYYY-MM-DD calendar-date
 * string in `timeZone`'s local wall-clock time — for the FLOOR_AVAILABLE
 * notification's slotDate (both the message body and the deep-link
 * `?date=` param), which previously used `startsAt.toISOString().slice(0,
 * 10)` (the raw UTC date) regardless of the freed desk's building's
 * timezone, misdating the notification for any booking near local midnight
 * in a non-UTC building.
 */
export function localDateStr(instant: Date, timeZone: string): string {
  const zoned = toZonedTime(instant, timeZone)
  const y = zoned.getFullYear()
  const m = String(zoned.getMonth() + 1).padStart(2, '0')
  const d = String(zoned.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

export interface WorkingHours {
  start: string
  end: string
  /** Org-wide switch — when false, `start`/`end` are configured but not enforced. */
  enforce: boolean
}

/** Resolve the working-hours window that applies to this building: its own override, falling back to the org default. */
export async function resolveWorkingHours(client: Prisma.TransactionClient, buildingId: string | null | undefined): Promise<WorkingHours> {
  const org = await client.organisation.findFirst({ select: { workingHoursStart: true, workingHoursEnd: true, enforceWorkingHours: true } })
  const orgStart = org?.workingHoursStart ?? '07:00'
  const orgEnd = org?.workingHoursEnd ?? '19:00'
  const enforce = org?.enforceWorkingHours ?? false
  if (!buildingId) return { start: orgStart, end: orgEnd, enforce }
  const building = await client.building.findUnique({ where: { id: buildingId }, select: { workingHoursStart: true, workingHoursEnd: true } })
  return {
    start: building?.workingHoursStart ?? orgStart,
    end: building?.workingHoursEnd ?? orgEnd,
    enforce,
  }
}

/**
 * Converts a wall-clock date+time meant to represent local time in
 * `timeZone` to the correct UTC instant, DST-aware — used to build each
 * recurring-series occurrence so "9am every Monday" stays 9am local through
 * a DST transition (the UTC instant shifts, not the local wall-clock — see
 * #72's confirmed design) rather than assuming a fixed UTC offset.
 *
 * `new Date(year, month0, day, hour, minute)` sets fields via the runtime's
 * local getters/setters — safe here (regardless of the server process's own
 * TZ) because `fromZonedTime` reads those same local getters back and
 * reinterprets them as wall-clock time in `timeZone`. Do not swap this for a
 * UTC-parsed ISO string; that would desynchronise the write/read side and
 * make the conversion depend on the server's TZ again.
 */
export function zonedWallClockToUtc(year: number, month1to12: number, day: number, hour: number, minute: number, timeZone: string): Date {
  const localWallClock = new Date(year, month1to12 - 1, day, hour, minute, 0, 0)
  return fromZonedTime(localWallClock, timeZone)
}

/**
 * True when [startsAt, endsAt) falls within [hoursStart, hoursEnd) local
 * clock time in `timeZone`. A booking spanning two or more *full* local
 * calendar days (e.g. Monday 9am to Wednesday 5pm) is deliberately exempt —
 * enforcing an hours-of-day window against a genuine multi-day booking would
 * require every full day in between to also fit a same-day window
 * (impossible unless the window is 00:00–24:00), and a multi-day desk
 * booking is a different use case than the single-session in-office
 * bookings working hours are meant to bound.
 *
 * A booking that merely tips a few minutes past local midnight (e.g.
 * 8am–11:05pm the same evening) is NOT a multi-day booking in that sense —
 * treating "different calendar date" as the exemption trigger (the
 * original check here) made it trivial to defeat working-hours enforcement
 * entirely just by picking an end time a minute or two after midnight, with
 * no minimum span required. A one-calendar-day crossing is instead checked
 * by extending the end time past 24:00 (e.g. 00:05 becomes 24:05) so it's
 * compared against the same day's window on a continuous clock, exactly as
 * a person booking "9am to just after midnight" would expect that session
 * to still be judged against the evening's own working-hours cutoff.
 */
export function isWithinWorkingHours(startsAt: Date, endsAt: Date, timeZone: string, hoursStart: string, hoursEnd: string): boolean {
  const localStart = toZonedTime(startsAt, timeZone)
  const localEnd = toZonedTime(endsAt, timeZone)

  const localMidnightUtcMs = (d: Date) => Date.UTC(d.getFullYear(), d.getMonth(), d.getDate())
  const dayDiff = Math.round((localMidnightUtcMs(localEnd) - localMidnightUtcMs(localStart)) / (24 * 60 * 60 * 1000))
  if (dayDiff >= 2) return true

  const [startH, startM] = hoursStart.split(':').map(Number)
  const [endH, endM] = hoursEnd.split(':').map(Number)
  const windowStartMinutes = startH * 60 + startM
  const windowEndMinutes = endH * 60 + endM

  const bookingStartMinutes = localStart.getHours() * 60 + localStart.getMinutes()
  // dayDiff is 0 (same day) or 1 (tips into the next calendar day) here —
  // in the latter case, extend past 24:00 rather than wrapping back to a
  // small number, so e.g. 00:05 the next day compares as 24:05, correctly
  // past any window's end rather than looking like early-morning-in-hours.
  const bookingEndMinutes = dayDiff * 24 * 60 + localEnd.getHours() * 60 + localEnd.getMinutes()

  return bookingStartMinutes >= windowStartMinutes && bookingEndMinutes <= windowEndMinutes
}
