import { prisma } from '../lib/prisma.js'
import { resolveBuildingTimezone, resolveWorkingHours, zonedWallClockToUtc } from '../lib/timezone.js'

export function effectiveDateRangeStrings(startDateParam: string | undefined, endDateParam: string | undefined, defaultDays: number) {
  const today = new Date()
  return { endDateStr: endDateParam ?? today.toISOString().slice(0, 10), startDateStr: startDateParam ?? new Date(today.getTime() - defaultDays * 86400000).toISOString().slice(0, 10) }
}
export function localDayBoundsSql(startDateStr: string, endDateStr: string) { return { startLocal: `${startDateStr} 00:00:00`, endLocal: `${endDateStr} 23:59:59.999` } }
export function calendarDateObjects(startDateStr: string, endDateStr: string) { return { startDate: new Date(`${startDateStr}T00:00:00.000Z`), endDate: new Date(`${endDateStr}T23:59:59.999Z`) } }
export function addDaysToDateStr(dateStr: string, days: number): string { const [y, m, d] = dateStr.split('-').map(Number); const dt = new Date(Date.UTC(y, m - 1, d)); dt.setUTCDate(dt.getUTCDate() + days); return dt.toISOString().slice(0, 10) }
export async function localDayBoundsForBuilding(buildingId: string | null, startDateStr: string, endDateStr: string, cache: Map<string | null, { start: Date; endExclusive: Date }>) {
  const cached = cache.get(buildingId); if (cached) return cached
  const tz = await resolveBuildingTimezone(prisma, buildingId); const [sy, sm, sd] = startDateStr.split('-').map(Number); const [ey, em, ed] = addDaysToDateStr(endDateStr, 1).split('-').map(Number)
  const bounds = { start: zonedWallClockToUtc(sy, sm, sd, 0, 0, tz), endExclusive: zonedWallClockToUtc(ey, em, ed, 0, 0, tz) }; cache.set(buildingId, bounds); return bounds
}
export async function workingHoursSpanForBuilding(buildingId: string | null, cache: Map<string | null, number>): Promise<number> {
  const cached = cache.get(buildingId); if (cached !== undefined) return cached
  const hours = await resolveWorkingHours(prisma, buildingId); const [sh, sm] = hours.start.split(':').map(Number); const [eh, em] = hours.end.split(':').map(Number)
  const span = (eh * 60 + em - (sh * 60 + sm)) / 60; cache.set(buildingId, span > 0 ? span : 8); return cache.get(buildingId)!
}
export function overlapHours(aStart: Date, aEnd: Date, bStart: Date, bEnd: Date): number { const start = aStart > bStart ? aStart : bStart; const end = aEnd < bEnd ? aEnd : bEnd; return Math.max(0, (end.getTime() - start.getTime()) / 3600000) }
export function countWorkingDays(start: Date, end: Date): number { let days = 0; const cursor = new Date(start); while (cursor <= end) { const day = cursor.getUTCDay(); if (day !== 0 && day !== 6) days++; cursor.setUTCDate(cursor.getUTCDate() + 1) } return days || 1 }
