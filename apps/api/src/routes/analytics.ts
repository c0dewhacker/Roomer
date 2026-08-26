import type { FastifyInstance } from 'fastify'
import { Prisma } from '@prisma/client'
import { prisma } from '../lib/prisma.js'
import { GlobalRole } from '@roomer/shared'
import { requireAuth } from '../middleware/requireAuth.js'
import { getManagedBuildingIds } from '../middleware/requireRole.js'
import { wantsCsv, sendCsv } from '../lib/csv.js'
import { resolveBuildingTimezone, zonedWallClockToUtc, calendarDaysUntil } from '../lib/timezone.js'
import { z } from 'zod'

const analyticsQuerySchema = z.object({
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'startDate must be YYYY-MM-DD').optional(),
  endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'endDate must be YYYY-MM-DD').optional(),
  buildingId: z.string().optional(),
  floorId: z.string().optional(),
})

/**
 * Effective [startDate, endDate] as plain YYYY-MM-DD calendar-date strings —
 * either the caller's explicit query params, or a default rolling window
 * ending "today" (UTC — there's no single relevant building to anchor an
 * unscoped default window to). Every consumer below compares these against
 * each row's OWN building's timezone (Postgres's AT TIME ZONE for raw SQL
 * queries, or resolveBuildingTimezone/zonedWallClockToUtc for Prisma ORM
 * queries) rather than a fixed UTC instant — the previous
 * `new Date(value + 'T00:00:00.000Z')` anchored every date string to UTC
 * midnight regardless of which building's calendar day was actually meant,
 * silently including/excluding up to a full day's data near the boundary
 * for any building whose timezone isn't UTC (see #274's release notes —
 * this was deliberately deferred out of the 1.0 release, fixed here).
 */
function effectiveDateRangeStrings(startDateParam: string | undefined, endDateParam: string | undefined, defaultDays: number): { startDateStr: string; endDateStr: string } {
  const today = new Date()
  const endDateStr = endDateParam ?? today.toISOString().slice(0, 10)
  const startDateStr = startDateParam ?? new Date(today.getTime() - defaultDays * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)
  return { startDateStr, endDateStr }
}

/**
 * Naive (no timezone suffix) local-day boundary strings for a calendar-date
 * range — passed as `::timestamp` literals into a raw SQL query and compared
 * against a column already converted to per-row local wall-clock time via
 * `AT TIME ZONE`, so the comparison happens entirely in "local time" space
 * rather than as a UTC instant.
 *
 * IMPORTANT for every raw-SQL AT TIME ZONE usage below: Booking.startsAt is
 * `timestamp(3) WITHOUT time zone` in Postgres (Prisma's plain `DateTime`
 * default, no `@db.Timestamptz`), even though the values it holds are real
 * UTC instants. `AT TIME ZONE` is overloaded and does the OPPOSITE
 * conversion depending on the operand's type: on a `timestamptz` it converts
 * TO local wall-clock time (what every fix here needs); on a bare
 * `timestamp` it does the reverse — reinterprets the naive value AS ALREADY
 * being local time in that zone and converts it TO a UTC instant. Applying
 * `AT TIME ZONE tz` directly to `b."startsAt"` silently produces the wrong
 * answer (verified live: it degenerates to comparing against the raw UTC
 * date, exactly the bug this fix exists to remove). The correct idiom,
 * used everywhere below, is the double conversion:
 * `(b."startsAt" AT TIME ZONE 'UTC') AT TIME ZONE tz` — the first
 * application reinterprets the naive value as UTC (correct, since that's
 * what it actually is) and produces a real `timestamptz`; the second then
 * converts that instant to local wall-clock time in `tz`.
 */
function localDayBoundsSql(startDateStr: string, endDateStr: string): { startLocal: string; endLocal: string } {
  return { startLocal: `${startDateStr} 00:00:00`, endLocal: `${endDateStr} 23:59:59.999` }
}

/** UTC-midnight Date objects for the calendar-date range — used only for the
 * timezone-agnostic countWorkingDays() weekday arithmetic below, never for
 * comparing against a real booking instant (see effectiveDateRangeStrings). */
function calendarDateObjects(startDateStr: string, endDateStr: string): { startDate: Date; endDate: Date } {
  return { startDate: new Date(startDateStr + 'T00:00:00.000Z'), endDate: new Date(endDateStr + 'T23:59:59.999Z') }
}

function addDaysToDateStr(dateStr: string, days: number): string {
  const [y, m, d] = dateStr.split('-').map(Number)
  const dt = new Date(Date.UTC(y, m - 1, d))
  dt.setUTCDate(dt.getUTCDate() + days)
  return dt.toISOString().slice(0, 10)
}

/**
 * Precise local-calendar-day [start, endExclusive) instant bounds for a
 * single building, resolved via the building's own timezone (or the org
 * default when buildingId is null) — for Prisma ORM query paths that can't
 * express a per-row `AT TIME ZONE` comparison in SQL, so the widen+JS-filter
 * pattern (see resolveBuildingTimezone call sites below) needs a real,
 * precise instant boundary per building instead. Half-open (< endExclusive,
 * not <= endInclusive) because zonedWallClockToUtc only takes hour/minute,
 * not seconds — a "day+1 at 00:00" exclusive upper bound is exact where an
 * inclusive "day at 23:59" would silently drop the last minute.
 */
async function localDayBoundsForBuilding(
  buildingId: string | null,
  startDateStr: string,
  endDateStr: string,
  cache: Map<string | null, { start: Date; endExclusive: Date }>,
): Promise<{ start: Date; endExclusive: Date }> {
  const cached = cache.get(buildingId)
  if (cached) return cached
  const tz = await resolveBuildingTimezone(prisma, buildingId)
  const [sy, sm, sd] = startDateStr.split('-').map(Number)
  const endExclusiveStr = addDaysToDateStr(endDateStr, 1)
  const [ey, em, ed] = endExclusiveStr.split('-').map(Number)
  const bounds = {
    start: zonedWallClockToUtc(sy, sm, sd, 0, 0, tz),
    endExclusive: zonedWallClockToUtc(ey, em, ed, 0, 0, tz),
  }
  cache.set(buildingId, bounds)
  return bounds
}

function countWorkingDays(start: Date, end: Date): number {
  // start/end are always parsed with an explicit UTC 'Z' suffix — use the UTC
  // variants throughout so both the weekday check and the day-by-day walk
  // stay aligned with those boundaries regardless of the server's local
  // timezone (a local-time walk can skip or double-count a day, and
  // getDay() can misclassify the weekday, whenever local time differs from UTC).
  let days = 0
  const cursor = new Date(start)
  while (cursor <= end) {
    const d = cursor.getUTCDay()
    if (d !== 0 && d !== 6) days++
    cursor.setUTCDate(cursor.getUTCDate() + 1)
  }
  return days || 1
}

export async function analyticsRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.addHook('onRoute', (route) => { route.schema = { tags: ['Analytics'], ...route.schema } })

  // GET /utilisation — desk utilisation by floor/zone for a date range (SUPER_ADMIN or building admin)
  fastify.get(
    '/utilisation',
    { preHandler: [requireAuth] },
    async (request, reply) => {
      const result = analyticsQuerySchema.safeParse(request.query)
      if (!result.success) {
        return reply.status(400).send({
          error: { message: 'Invalid query parameters', code: 'VALIDATION_ERROR' },
        })
      }

      const isSuperAdmin = request.user.globalRole === GlobalRole.SUPER_ADMIN
      let managedBuildingIds: string[] = []
      if (!isSuperAdmin) {
        managedBuildingIds = await getManagedBuildingIds(request.user.id)
        if (managedBuildingIds.length === 0) {
          return reply.status(403).send({ error: { message: 'Insufficient permissions', code: 'FORBIDDEN' } })
        }
        if (result.data.buildingId && !managedBuildingIds.includes(result.data.buildingId)) {
          return reply.status(403).send({ error: { message: 'Insufficient permissions', code: 'FORBIDDEN' } })
        }
        if (result.data.floorId) {
          const floor = await prisma.floor.findUnique({ where: { id: result.data.floorId }, select: { buildingId: true } })
          if (!floor || !managedBuildingIds.includes(floor.buildingId)) {
            return reply.status(403).send({ error: { message: 'Insufficient permissions', code: 'FORBIDDEN' } })
          }
        }
      }

      const { startDateStr, endDateStr } = effectiveDateRangeStrings(result.data.startDate, result.data.endDate, 30)
      const { startDate: calStart, endDate: calEnd } = calendarDateObjects(startDateStr, endDateStr)
      const workingDays = countWorkingDays(calStart, calEnd)

      // Widened DB pre-filter (±14h covers every real-world UTC offset) — the
      // precise per-building local-day filter happens in JS below via
      // localDayBoundsForBuilding, since floors in this result can belong to
      // different-timezone buildings and Prisma's query builder can't express
      // a per-row AT TIME ZONE comparison the way raw SQL can.
      const widenedStart = new Date(calStart.getTime() - 14 * 60 * 60 * 1000)
      const widenedEnd = new Date(calEnd.getTime() + 14 * 60 * 60 * 1000)

      // Build floor/building filters
      const floorWhere: Record<string, unknown> = {}
      if (result.data.floorId) floorWhere.id = result.data.floorId
      if (result.data.buildingId) {
        floorWhere.buildingId = result.data.buildingId
      } else if (!isSuperAdmin) {
        floorWhere.buildingId = { in: managedBuildingIds }
      }

      const floors = await prisma.floor.findMany({
        where: Object.keys(floorWhere).length > 0 ? floorWhere : undefined,
        include: {
          building: { select: { id: true, name: true } },
          zones: {
            include: {
              assets: {
                where: { isBookable: true },
                include: {
                  bookings: {
                    where: {
                      // Includes COMPLETED alongside CONFIRMED: handleAutoCompleteBookings
                      // (queue.ts) flips a booking's status 30 minutes after it ends, so any
                      // backward-looking range (the default here is the last 30 days) is
                      // querying almost entirely for bookings that have since become
                      // COMPLETED — CONFIRMED-only silently undercounted historical usage
                      // toward zero the further back a booking's endsAt was.
                      status: { in: ['CONFIRMED', 'COMPLETED'] },
                      startsAt: { gte: widenedStart, lte: widenedEnd },
                    },
                    select: { id: true, startsAt: true },
                  },
                },
              },
            },
          },
        },
      })

      const buildingDayBoundsCache = new Map<string | null, { start: Date; endExclusive: Date }>()
      const data = (await Promise.all(floors.flatMap((floor) =>
        floor.zones.map(async (zone) => {
          const { start, endExclusive } = await localDayBoundsForBuilding(floor.building.id, startDateStr, endDateStr, buildingDayBoundsCache)
          const bookableDesks = zone.assets.filter((a) => a.bookingStatus === 'OPEN' || a.bookingStatus === 'RESTRICTED')
          const assignedDesks = zone.assets.filter((a) => a.bookingStatus === 'ASSIGNED')
          const disabledDesks = zone.assets.filter((a) => a.bookingStatus === 'DISABLED')
          const bookingCount = zone.assets.reduce((sum, a) => sum + a.bookings.filter((b) => b.startsAt >= start && b.startsAt < endExclusive).length, 0)
          // Capacity = OPEN + RESTRICTED + ASSIGNED (non-disabled); DISABLED are out of service
          const activeDesks = bookableDesks.length + assignedDesks.length
          const capacity = activeDesks * workingDays
          const utilisation = capacity > 0 ? Math.round((bookingCount / capacity) * 100) : 0

          return {
            floorId: floor.id,
            floorName: floor.name,
            buildingId: floor.building.id,
            buildingName: floor.building.name,
            zoneId: zone.id,
            zoneName: zone.name,
            totalDesks: zone.assets.length,
            bookableDesks: bookableDesks.length,
            assignedDesks: assignedDesks.length,
            disabledDesks: disabledDesks.length,
            bookingCount,
            workingDays,
            utilisationPct: utilisation,
          }
        }),
      )))

      if (wantsCsv(request)) {
        return sendCsv(reply, 'zone-utilisation.csv',
          ['Floor', 'Zone', 'Total Desks', 'Bookable', 'Assigned', 'Disabled', 'Bookings', 'Utilisation %'],
          data.map((d) => [d.floorName, d.zoneName, d.totalDesks, d.bookableDesks, d.assignedDesks, d.disabledDesks, d.bookingCount, d.utilisationPct]),
        )
      }
      return reply.status(200).send({ data })
    },
  )

  // GET /bookings — booking counts by day for a date range (SUPER_ADMIN or building admin)
  fastify.get(
    '/bookings',
    { preHandler: [requireAuth] },
    async (request, reply) => {
      const result = analyticsQuerySchema.safeParse(request.query)
      if (!result.success) {
        return reply.status(400).send({
          error: { message: 'Invalid query parameters', code: 'VALIDATION_ERROR' },
        })
      }

      const isSuperAdmin = request.user.globalRole === GlobalRole.SUPER_ADMIN
      let managedBuildingIds: string[] = []
      if (!isSuperAdmin) {
        managedBuildingIds = await getManagedBuildingIds(request.user.id)
        if (managedBuildingIds.length === 0) {
          return reply.status(403).send({ error: { message: 'Insufficient permissions', code: 'FORBIDDEN' } })
        }
        if (result.data.buildingId && !managedBuildingIds.includes(result.data.buildingId)) {
          return reply.status(403).send({ error: { message: 'Insufficient permissions', code: 'FORBIDDEN' } })
        }
        if (result.data.floorId) {
          const floor = await prisma.floor.findUnique({ where: { id: result.data.floorId }, select: { buildingId: true } })
          if (!floor || !managedBuildingIds.includes(floor.buildingId)) {
            return reply.status(403).send({ error: { message: 'Insufficient permissions', code: 'FORBIDDEN' } })
          }
        }
      }

      const { startDateStr, endDateStr } = effectiveDateRangeStrings(result.data.startDate, result.data.endDate, 30)
      const { startLocal, endLocal } = localDayBoundsSql(startDateStr, endDateStr)

      type BookingCountRow = { date: Date; count: bigint }

      let rows: BookingCountRow[]

      if (result.data.floorId) {
        const floorForTz = await prisma.floor.findUnique({ where: { id: result.data.floorId }, select: { buildingId: true } })
        const tz = await resolveBuildingTimezone(prisma, floorForTz?.buildingId ?? null)
        rows = await prisma.$queryRaw<BookingCountRow[]>`
          SELECT DATE((b."startsAt" AT TIME ZONE 'UTC') AT TIME ZONE ${tz}) AS date, COUNT(*)::bigint AS count
          FROM "Booking" b
          JOIN "Asset" a ON a.id = b."assetId"
          WHERE ((b."startsAt" AT TIME ZONE 'UTC') AT TIME ZONE ${tz}) >= ${startLocal}::timestamp
            AND ((b."startsAt" AT TIME ZONE 'UTC') AT TIME ZONE ${tz}) <= ${endLocal}::timestamp
            AND b.status IN ('CONFIRMED', 'COMPLETED')
            AND a."floorId" = ${result.data.floorId}
          GROUP BY date
          ORDER BY date ASC
        `
      } else if (result.data.buildingId) {
        const tz = await resolveBuildingTimezone(prisma, result.data.buildingId)
        rows = await prisma.$queryRaw<BookingCountRow[]>`
          SELECT DATE((b."startsAt" AT TIME ZONE 'UTC') AT TIME ZONE ${tz}) AS date, COUNT(*)::bigint AS count
          FROM "Booking" b
          JOIN "Asset" a ON a.id = b."assetId"
          JOIN "Floor" f ON f.id = a."floorId"
          WHERE ((b."startsAt" AT TIME ZONE 'UTC') AT TIME ZONE ${tz}) >= ${startLocal}::timestamp
            AND ((b."startsAt" AT TIME ZONE 'UTC') AT TIME ZONE ${tz}) <= ${endLocal}::timestamp
            AND b.status IN ('CONFIRMED', 'COMPLETED')
            AND f."buildingId" = ${result.data.buildingId}
          GROUP BY date
          ORDER BY date ASC
        `
      } else if (!isSuperAdmin) {
        const orgDefaultTz = await resolveBuildingTimezone(prisma, null)
        rows = await prisma.$queryRaw<BookingCountRow[]>`
          SELECT DATE((b."startsAt" AT TIME ZONE 'UTC') AT TIME ZONE COALESCE(bld.timezone, ${orgDefaultTz})) AS date, COUNT(*)::bigint AS count
          FROM "Booking" b
          JOIN "Asset" a ON a.id = b."assetId"
          JOIN "Floor" f ON f.id = a."floorId"
          JOIN "Building" bld ON bld.id = f."buildingId"
          WHERE ((b."startsAt" AT TIME ZONE 'UTC') AT TIME ZONE COALESCE(bld.timezone, ${orgDefaultTz})) >= ${startLocal}::timestamp
            AND ((b."startsAt" AT TIME ZONE 'UTC') AT TIME ZONE COALESCE(bld.timezone, ${orgDefaultTz})) <= ${endLocal}::timestamp
            AND b.status IN ('CONFIRMED', 'COMPLETED')
            AND f."buildingId" = ANY(${managedBuildingIds})
          GROUP BY date
          ORDER BY date ASC
        `
      } else {
        // LEFT JOIN (not INNER) — an asset with no floor (Asset.floorId is
        // nullable) still has its bookings counted here, same as the
        // previous unjoined query; COALESCE falls back to the org default
        // timezone for those rows since they have no building to resolve.
        const orgDefaultTz = await resolveBuildingTimezone(prisma, null)
        rows = await prisma.$queryRaw<BookingCountRow[]>`
          SELECT DATE((b."startsAt" AT TIME ZONE 'UTC') AT TIME ZONE COALESCE(bld.timezone, ${orgDefaultTz})) AS date, COUNT(*)::bigint AS count
          FROM "Booking" b
          LEFT JOIN "Asset" a ON a.id = b."assetId"
          LEFT JOIN "Floor" f ON f.id = a."floorId"
          LEFT JOIN "Building" bld ON bld.id = f."buildingId"
          WHERE ((b."startsAt" AT TIME ZONE 'UTC') AT TIME ZONE COALESCE(bld.timezone, ${orgDefaultTz})) >= ${startLocal}::timestamp
            AND ((b."startsAt" AT TIME ZONE 'UTC') AT TIME ZONE COALESCE(bld.timezone, ${orgDefaultTz})) <= ${endLocal}::timestamp
            AND b.status IN ('CONFIRMED', 'COMPLETED')
          GROUP BY date
          ORDER BY date ASC
        `
      }

      const data = rows.map((r) => ({
        date: r.date instanceof Date ? r.date.toISOString().split('T')[0] : String(r.date),
        count: Number(r.count),
      }))

      if (wantsCsv(request)) {
        return sendCsv(reply, 'booking-activity.csv', ['Date', 'Bookings'], data.map((d) => [d.date, d.count]))
      }
      return reply.status(200).send({ data })
    },
  )

  // GET /summary — KPI summary stats (SUPER_ADMIN or building admin scoped to managed buildings)
  fastify.get(
    '/summary',
    { preHandler: [requireAuth] },
    async (request, reply) => {
      const result = analyticsQuerySchema.safeParse(request.query)
      if (!result.success) return reply.status(400).send({ error: { message: 'Invalid query', code: 'VALIDATION_ERROR' } })

      const isSuperAdmin = request.user.globalRole === GlobalRole.SUPER_ADMIN
      let managedBuildingIds: string[] = []
      if (!isSuperAdmin) {
        managedBuildingIds = await getManagedBuildingIds(request.user.id)
        if (managedBuildingIds.length === 0) {
          return reply.status(403).send({ error: { message: 'Insufficient permissions', code: 'FORBIDDEN' } })
        }
        if (result.data.buildingId && !managedBuildingIds.includes(result.data.buildingId)) {
          return reply.status(403).send({ error: { message: 'Insufficient permissions', code: 'FORBIDDEN' } })
        }
      }

      const { startDateStr, endDateStr } = effectiveDateRangeStrings(result.data.startDate, result.data.endDate, 30)
      const { startDate: calStart, endDate: calEnd } = calendarDateObjects(startDateStr, endDateStr)
      const workingDays = countWorkingDays(calStart, calEnd)
      // Widened DB pre-filter (±14h) — see /utilisation above for why: the
      // precise per-building local-day filter happens in JS below since
      // Prisma's count()/findMany() can't express a per-row AT TIME ZONE
      // comparison the way raw SQL can.
      const widenedStart = new Date(calStart.getTime() - 14 * 60 * 60 * 1000)
      const widenedEnd = new Date(calEnd.getTime() + 14 * 60 * 60 * 1000)

      // result.data.buildingId (the Reports page's Building filter) was
      // accepted here but never referenced — only the non-admin managed-
      // buildings scope was ever applied, so picking a specific building in
      // the dropdown silently did nothing; a building admin managing several
      // buildings, or a super admin, always saw combined org-wide figures.
      const buildingIdFilter = result.data.buildingId
        ? { in: [result.data.buildingId] }
        : !isSuperAdmin ? { in: managedBuildingIds } : undefined
      const bookingBuildingFilter = buildingIdFilter
        ? { asset: { floor: { buildingId: buildingIdFilter } } }
        : {}
      const assetBuildingFilter = buildingIdFilter
        ? { floor: { buildingId: buildingIdFilter } }
        : {}
      const queueBuildingFilter = buildingIdFilter
        ? { asset: { floor: { buildingId: buildingIdFilter } } }
        : {}

      const bookingWhere: Record<string, unknown> = { startsAt: { gte: widenedStart, lte: widenedEnd }, ...bookingBuildingFilter }

      const [widenedBookings, bookableDesks, assignedDesks, disabledDesks, queueDepth] = await Promise.all([
        prisma.booking.findMany({
          where: { ...bookingWhere, status: { in: ['CONFIRMED', 'CANCELLED', 'COMPLETED'] } },
          select: { status: true, noShow: true, userId: true, startsAt: true, asset: { select: { floor: { select: { buildingId: true } } } } },
        }),
        // OPEN + RESTRICTED = freely bookable assets
        prisma.asset.count({ where: { isBookable: true, bookingStatus: { in: ['OPEN', 'RESTRICTED'] }, ...assetBuildingFilter } }),
        prisma.asset.count({ where: { isBookable: true, bookingStatus: 'ASSIGNED', ...assetBuildingFilter } }),
        prisma.asset.count({ where: { isBookable: true, bookingStatus: 'DISABLED', ...assetBuildingFilter } }),
        prisma.queueEntry.count({ where: { status: 'WAITING', ...queueBuildingFilter } }),
      ])

      const summaryDayBoundsCache = new Map<string | null, { start: Date; endExclusive: Date }>()
      const inRangeBookings = []
      for (const b of widenedBookings) {
        const buildingId = b.asset.floor?.buildingId ?? null
        const { start, endExclusive } = await localDayBoundsForBuilding(buildingId, startDateStr, endDateStr, summaryDayBoundsCache)
        if (b.startsAt >= start && b.startsAt < endExclusive) inRangeBookings.push(b)
      }
      const confirmed = inRangeBookings.filter((b) => b.status === 'CONFIRMED').length
      const cancelled = inRangeBookings.filter((b) => b.status === 'CANCELLED').length
      const noShowCount = inRangeBookings.filter((b) => b.status === 'CANCELLED' && b.noShow).length
      const completed = inRangeBookings.filter((b) => b.status === 'COMPLETED').length
      const uniqueBookers = new Set(inRangeBookings.filter((b) => b.status === 'CONFIRMED' || b.status === 'COMPLETED').map((b) => b.userId))

      const totalDesks = bookableDesks + assignedDesks + disabledDesks
      const totalAttempted = confirmed + cancelled + completed
      // "cancelled" includes no-show releases — separate them so each rate is distinct.
      const manualCancelled = Math.max(0, cancelled - noShowCount)
      const cancellationRate = totalAttempted > 0 ? Math.round((manualCancelled / totalAttempted) * 100) : 0
      const noShowRate = totalAttempted > 0 ? Math.round((noShowCount / totalAttempted) * 100) : 0
      // Capacity = all non-disabled desks (OPEN + RESTRICTED + ASSIGNED); disabled are truly out of service
      const activeDesks = bookableDesks + assignedDesks
      const totalCapacity = activeDesks * workingDays
      // "Happened" = confirmed (still upcoming/in-progress) + completed
      // (handleAutoCompleteBookings flips a booking's status 30 minutes
      // after it ends) — the headline booking/utilisation figures below
      // need both, same reasoning as uniqueBookers a few lines above.
      // `confirmed` alone silently collapsed toward zero for any
      // backward-looking range, since almost every booking in the past has
      // already transitioned to COMPLETED by the time anyone views this.
      const happened = confirmed + completed
      const overallUtilisationPct = totalCapacity > 0 ? Math.round((happened / totalCapacity) * 100) : 0

      return reply.status(200).send({
        data: {
          totalBookings: happened,
          cancelledBookings: manualCancelled,
          completedBookings: completed,
          cancellationRate,
          noShowBookings: noShowCount,
          noShowRate,
          uniqueBookers: uniqueBookers.size,
          avgDailyBookings: Math.round((happened / workingDays) * 10) / 10,
          totalDesks,
          bookableDesks,
          assignedDesks,
          disabledDesks,
          overallUtilisationPct,
          queueDepth,
          workingDays,
        },
      })
    },
  )

  // GET /status-breakdown — booking counts by status (SUPER_ADMIN or building admin scoped to managed buildings)
  fastify.get(
    '/status-breakdown',
    { preHandler: [requireAuth] },
    async (request, reply) => {
      const result = analyticsQuerySchema.safeParse(request.query)
      if (!result.success) return reply.status(400).send({ error: { message: 'Invalid query', code: 'VALIDATION_ERROR' } })

      const isSuperAdmin = request.user.globalRole === GlobalRole.SUPER_ADMIN
      let managedBuildingIds: string[] = []
      if (!isSuperAdmin) {
        managedBuildingIds = await getManagedBuildingIds(request.user.id)
        if (managedBuildingIds.length === 0) {
          return reply.status(403).send({ error: { message: 'Insufficient permissions', code: 'FORBIDDEN' } })
        }
        if (result.data.buildingId && !managedBuildingIds.includes(result.data.buildingId)) {
          return reply.status(403).send({ error: { message: 'Insufficient permissions', code: 'FORBIDDEN' } })
        }
      }

      const { startDateStr, endDateStr } = effectiveDateRangeStrings(result.data.startDate, result.data.endDate, 30)
      const { startDate: calStart, endDate: calEnd } = calendarDateObjects(startDateStr, endDateStr)
      const widenedStart = new Date(calStart.getTime() - 14 * 60 * 60 * 1000)
      const widenedEnd = new Date(calEnd.getTime() + 14 * 60 * 60 * 1000)

      // Same gap as /summary above — result.data.buildingId was accepted but
      // never referenced, only the non-admin managed-buildings scope was ever applied.
      const buildingIdFilter = result.data.buildingId
        ? { in: [result.data.buildingId] }
        : !isSuperAdmin ? { in: managedBuildingIds } : undefined
      const buildingFilter = buildingIdFilter
        ? { asset: { floor: { buildingId: buildingIdFilter } } }
        : {}

      const widenedRows = await prisma.booking.findMany({
        where: { startsAt: { gte: widenedStart, lte: widenedEnd }, status: { in: ['CONFIRMED', 'CANCELLED', 'COMPLETED'] }, ...buildingFilter },
        select: { status: true, startsAt: true, asset: { select: { floor: { select: { buildingId: true } } } } },
      })
      const statusDayBoundsCache = new Map<string | null, { start: Date; endExclusive: Date }>()
      let confirmed = 0, cancelled = 0, completed = 0
      for (const b of widenedRows) {
        const buildingId = b.asset.floor?.buildingId ?? null
        const { start, endExclusive } = await localDayBoundsForBuilding(buildingId, startDateStr, endDateStr, statusDayBoundsCache)
        if (b.startsAt < start || b.startsAt >= endExclusive) continue
        if (b.status === 'CONFIRMED') confirmed++
        else if (b.status === 'CANCELLED') cancelled++
        else if (b.status === 'COMPLETED') completed++
      }

      const data = [
        { status: 'CONFIRMED', label: 'Confirmed', count: confirmed },
        { status: 'COMPLETED', label: 'Completed', count: completed },
        { status: 'CANCELLED', label: 'Cancelled', count: cancelled },
      ]
      if (wantsCsv(request)) {
        return sendCsv(reply, 'booking-status.csv', ['Status', 'Count'], data.map((d) => [d.label, d.count]))
      }
      return reply.status(200).send({ data })
    },
  )

  // GET /peak-days — bookings grouped by day of week (SUPER_ADMIN or building admin scoped to managed buildings)
  fastify.get(
    '/peak-days',
    { preHandler: [requireAuth] },
    async (request, reply) => {
      const result = analyticsQuerySchema.safeParse(request.query)
      if (!result.success) return reply.status(400).send({ error: { message: 'Invalid query', code: 'VALIDATION_ERROR' } })

      const isSuperAdmin = request.user.globalRole === GlobalRole.SUPER_ADMIN
      let managedBuildingIds: string[] = []
      if (!isSuperAdmin) {
        managedBuildingIds = await getManagedBuildingIds(request.user.id)
        if (managedBuildingIds.length === 0) {
          return reply.status(403).send({ error: { message: 'Insufficient permissions', code: 'FORBIDDEN' } })
        }
        if (result.data.buildingId && !managedBuildingIds.includes(result.data.buildingId)) {
          return reply.status(403).send({ error: { message: 'Insufficient permissions', code: 'FORBIDDEN' } })
        }
      }

      const { startDateStr, endDateStr } = effectiveDateRangeStrings(result.data.startDate, result.data.endDate, 30)
      const { startLocal, endLocal } = localDayBoundsSql(startDateStr, endDateStr)

      // result.data.buildingId was accepted but never referenced — only the
      // super-admin/managed-buildings branches existed, so picking a specific
      // building in the Reports page filter silently did nothing.
      type DowRow = { dow: string; count: bigint }
      let rows: DowRow[]
      if (result.data.buildingId) {
        const tz = await resolveBuildingTimezone(prisma, result.data.buildingId)
        rows = await prisma.$queryRaw<DowRow[]>`
          SELECT EXTRACT(DOW FROM ((b."startsAt" AT TIME ZONE 'UTC') AT TIME ZONE ${tz})) AS dow, COUNT(*)::bigint AS count
          FROM "Booking" b
          JOIN "Asset" a ON a.id = b."assetId"
          JOIN "Floor" f ON f.id = a."floorId"
          WHERE ((b."startsAt" AT TIME ZONE 'UTC') AT TIME ZONE ${tz}) >= ${startLocal}::timestamp
            AND ((b."startsAt" AT TIME ZONE 'UTC') AT TIME ZONE ${tz}) <= ${endLocal}::timestamp
            AND b.status IN ('CONFIRMED', 'COMPLETED')
            AND f."buildingId" = ${result.data.buildingId}
          GROUP BY dow
          ORDER BY dow ASC
        `
      } else if (isSuperAdmin) {
        // LEFT JOIN — see /bookings above for why a floor-less asset's
        // bookings must still be included (falling back to the org default tz).
        const orgDefaultTz = await resolveBuildingTimezone(prisma, null)
        rows = await prisma.$queryRaw<DowRow[]>`
          SELECT EXTRACT(DOW FROM ((b."startsAt" AT TIME ZONE 'UTC') AT TIME ZONE COALESCE(bld.timezone, ${orgDefaultTz}))) AS dow, COUNT(*)::bigint AS count
          FROM "Booking" b
          LEFT JOIN "Asset" a ON a.id = b."assetId"
          LEFT JOIN "Floor" f ON f.id = a."floorId"
          LEFT JOIN "Building" bld ON bld.id = f."buildingId"
          WHERE ((b."startsAt" AT TIME ZONE 'UTC') AT TIME ZONE COALESCE(bld.timezone, ${orgDefaultTz})) >= ${startLocal}::timestamp
            AND ((b."startsAt" AT TIME ZONE 'UTC') AT TIME ZONE COALESCE(bld.timezone, ${orgDefaultTz})) <= ${endLocal}::timestamp
            AND b.status IN ('CONFIRMED', 'COMPLETED')
          GROUP BY dow
          ORDER BY dow ASC
        `
      } else {
        const orgDefaultTz = await resolveBuildingTimezone(prisma, null)
        rows = await prisma.$queryRaw<DowRow[]>`
          SELECT EXTRACT(DOW FROM ((b."startsAt" AT TIME ZONE 'UTC') AT TIME ZONE COALESCE(bld.timezone, ${orgDefaultTz}))) AS dow, COUNT(*)::bigint AS count
          FROM "Booking" b
          JOIN "Asset" a ON a.id = b."assetId"
          JOIN "Floor" f ON f.id = a."floorId"
          JOIN "Building" bld ON bld.id = f."buildingId"
          WHERE ((b."startsAt" AT TIME ZONE 'UTC') AT TIME ZONE COALESCE(bld.timezone, ${orgDefaultTz})) >= ${startLocal}::timestamp
            AND ((b."startsAt" AT TIME ZONE 'UTC') AT TIME ZONE COALESCE(bld.timezone, ${orgDefaultTz})) <= ${endLocal}::timestamp
            AND b.status IN ('CONFIRMED', 'COMPLETED')
            AND f."buildingId" = ANY(${managedBuildingIds})
          GROUP BY dow
          ORDER BY dow ASC
        `
      }

      const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
      const countByDow: Record<number, number> = {}
      rows.forEach((r) => { countByDow[Number(r.dow)] = Number(r.count) })

      const data = [1, 2, 3, 4, 5, 0, 6].map((d) => ({
        dayOfWeek: d,
        dayName: DAY_NAMES[d],
        count: countByDow[d] ?? 0,
      }))

      if (wantsCsv(request)) {
        return sendCsv(reply, 'peak-days.csv', ['Day', 'Bookings'], data.map((d) => [d.dayName, d.count]))
      }
      return reply.status(200).send({ data })
    },
  )

  // GET /floor-utilisation — floor-level aggregated utilisation (SUPER_ADMIN or building admin)
  fastify.get(
    '/floor-utilisation',
    { preHandler: [requireAuth] },
    async (request, reply) => {
      const result = analyticsQuerySchema.safeParse(request.query)
      if (!result.success) return reply.status(400).send({ error: { message: 'Invalid query', code: 'VALIDATION_ERROR' } })

      const isSuperAdmin = request.user.globalRole === GlobalRole.SUPER_ADMIN
      let managedBuildingIds: string[] = []
      if (!isSuperAdmin) {
        managedBuildingIds = await getManagedBuildingIds(request.user.id)
        if (managedBuildingIds.length === 0) {
          return reply.status(403).send({ error: { message: 'Insufficient permissions', code: 'FORBIDDEN' } })
        }
        if (result.data.buildingId && !managedBuildingIds.includes(result.data.buildingId)) {
          return reply.status(403).send({ error: { message: 'Insufficient permissions', code: 'FORBIDDEN' } })
        }
      }

      const { startDateStr, endDateStr } = effectiveDateRangeStrings(result.data.startDate, result.data.endDate, 30)
      const { startDate: calStart, endDate: calEnd } = calendarDateObjects(startDateStr, endDateStr)
      const workingDays = countWorkingDays(calStart, calEnd)
      const widenedStart = new Date(calStart.getTime() - 14 * 60 * 60 * 1000)
      const widenedEnd = new Date(calEnd.getTime() + 14 * 60 * 60 * 1000)

      const floorWhere: Record<string, unknown> = {}
      if (result.data.buildingId) {
        floorWhere.buildingId = result.data.buildingId
      } else if (!isSuperAdmin) {
        floorWhere.buildingId = { in: managedBuildingIds }
      }

      const floors = await prisma.floor.findMany({
        where: Object.keys(floorWhere).length > 0 ? floorWhere : undefined,
        include: {
          building: { select: { id: true, name: true } },
          zones: {
            include: {
              assets: {
                where: { isBookable: true },
                include: {
                  bookings: {
                    // See /utilisation above — includes COMPLETED alongside
                    // CONFIRMED so historical usage isn't undercounted once
                    // handleAutoCompleteBookings flips old bookings' status.
                    where: { status: { in: ['CONFIRMED', 'COMPLETED'] }, startsAt: { gte: widenedStart, lte: widenedEnd } },
                    select: { id: true, startsAt: true },
                  },
                },
              },
            },
          },
        },
        orderBy: [{ building: { name: 'asc' } }, { name: 'asc' }],
      })

      const floorUtilDayBoundsCache = new Map<string | null, { start: Date; endExclusive: Date }>()
      const data = await Promise.all(floors.map(async (floor) => {
        const { start, endExclusive } = await localDayBoundsForBuilding(floor.building.id, startDateStr, endDateStr, floorUtilDayBoundsCache)
        const allAssets = floor.zones.flatMap((z) => z.assets)
        const bookableDesks = allAssets.filter((a) => a.bookingStatus === 'OPEN' || a.bookingStatus === 'RESTRICTED').length
        const assignedDesks = allAssets.filter((a) => a.bookingStatus === 'ASSIGNED').length
        const disabledDesks = allAssets.filter((a) => a.bookingStatus === 'DISABLED').length
        const bookingCount = allAssets.reduce((s, a) => s + a.bookings.filter((b) => b.startsAt >= start && b.startsAt < endExclusive).length, 0)
        // Capacity = all non-disabled assets; DISABLED are out of service and excluded
        const capacity = (bookableDesks + assignedDesks) * workingDays
        return {
          floorId: floor.id,
          floorName: floor.name,
          buildingId: floor.building.id,
          buildingName: floor.building.name,
          totalDesks: allAssets.length,
          bookableDesks,
          assignedDesks,
          disabledDesks,
          bookingCount,
          utilisationPct: capacity > 0 ? Math.round((bookingCount / capacity) * 100) : 0,
        }
      }))

      if (wantsCsv(request)) {
        return sendCsv(reply, 'floor-utilisation.csv',
          ['Building', 'Floor', 'Desks', 'Bookings', 'Utilisation %'],
          data.map((d) => [d.buildingName, d.floorName, d.totalDesks, d.bookingCount, d.utilisationPct]),
        )
      }
      return reply.status(200).send({ data })
    },
  )

  // GET /top-users — top users by booking count (SUPER_ADMIN or building admin)
  fastify.get(
    '/top-users',
    { preHandler: [requireAuth] },
    async (request, reply) => {
      const result = analyticsQuerySchema.safeParse(request.query)
      if (!result.success) {
        return reply.status(400).send({
          error: { message: 'Invalid query parameters', code: 'VALIDATION_ERROR' },
        })
      }

      const isSuperAdmin = request.user.globalRole === GlobalRole.SUPER_ADMIN
      let managedBuildingIds: string[] = []
      if (!isSuperAdmin) {
        managedBuildingIds = await getManagedBuildingIds(request.user.id)
        if (managedBuildingIds.length === 0) {
          return reply.status(403).send({ error: { message: 'Insufficient permissions', code: 'FORBIDDEN' } })
        }
        if (result.data.buildingId && !managedBuildingIds.includes(result.data.buildingId)) {
          return reply.status(403).send({ error: { message: 'Insufficient permissions', code: 'FORBIDDEN' } })
        }
        if (result.data.floorId) {
          const floor = await prisma.floor.findUnique({ where: { id: result.data.floorId }, select: { buildingId: true } })
          if (!floor || !managedBuildingIds.includes(floor.buildingId)) {
            return reply.status(403).send({ error: { message: 'Insufficient permissions', code: 'FORBIDDEN' } })
          }
        }
      }

      const { startDateStr, endDateStr } = effectiveDateRangeStrings(result.data.startDate, result.data.endDate, 30)
      const { startLocal, endLocal } = localDayBoundsSql(startDateStr, endDateStr)

      type TopUserRow = { userId: string; displayName: string; email: string; count: bigint }

      let rows: TopUserRow[]

      if (result.data.floorId) {
        const floorForTz = await prisma.floor.findUnique({ where: { id: result.data.floorId }, select: { buildingId: true } })
        const tz = await resolveBuildingTimezone(prisma, floorForTz?.buildingId ?? null)
        rows = await prisma.$queryRaw<TopUserRow[]>`
          SELECT b."userId", u."displayName", u.email, COUNT(*)::bigint AS count
          FROM "Booking" b
          JOIN "User" u ON u.id = b."userId"
          JOIN "Asset" a ON a.id = b."assetId"
          WHERE ((b."startsAt" AT TIME ZONE 'UTC') AT TIME ZONE ${tz}) >= ${startLocal}::timestamp
            AND ((b."startsAt" AT TIME ZONE 'UTC') AT TIME ZONE ${tz}) <= ${endLocal}::timestamp
            AND b.status IN ('CONFIRMED', 'COMPLETED')
            AND a."floorId" = ${result.data.floorId}
          GROUP BY b."userId", u."displayName", u.email
          ORDER BY count DESC
          LIMIT 20
        `
      } else if (result.data.buildingId) {
        const tz = await resolveBuildingTimezone(prisma, result.data.buildingId)
        rows = await prisma.$queryRaw<TopUserRow[]>`
          SELECT b."userId", u."displayName", u.email, COUNT(*)::bigint AS count
          FROM "Booking" b
          JOIN "User" u ON u.id = b."userId"
          JOIN "Asset" a ON a.id = b."assetId"
          JOIN "Floor" f ON f.id = a."floorId"
          WHERE ((b."startsAt" AT TIME ZONE 'UTC') AT TIME ZONE ${tz}) >= ${startLocal}::timestamp
            AND ((b."startsAt" AT TIME ZONE 'UTC') AT TIME ZONE ${tz}) <= ${endLocal}::timestamp
            AND b.status IN ('CONFIRMED', 'COMPLETED')
            AND f."buildingId" = ${result.data.buildingId}
          GROUP BY b."userId", u."displayName", u.email
          ORDER BY count DESC
          LIMIT 20
        `
      } else if (!isSuperAdmin) {
        const orgDefaultTz = await resolveBuildingTimezone(prisma, null)
        rows = await prisma.$queryRaw<TopUserRow[]>`
          SELECT b."userId", u."displayName", u.email, COUNT(*)::bigint AS count
          FROM "Booking" b
          JOIN "User" u ON u.id = b."userId"
          JOIN "Asset" a ON a.id = b."assetId"
          JOIN "Floor" f ON f.id = a."floorId"
          JOIN "Building" bld ON bld.id = f."buildingId"
          WHERE ((b."startsAt" AT TIME ZONE 'UTC') AT TIME ZONE COALESCE(bld.timezone, ${orgDefaultTz})) >= ${startLocal}::timestamp
            AND ((b."startsAt" AT TIME ZONE 'UTC') AT TIME ZONE COALESCE(bld.timezone, ${orgDefaultTz})) <= ${endLocal}::timestamp
            AND b.status IN ('CONFIRMED', 'COMPLETED')
            AND f."buildingId" = ANY(${managedBuildingIds})
          GROUP BY b."userId", u."displayName", u.email
          ORDER BY count DESC
          LIMIT 20
        `
      } else {
        // LEFT JOIN — see /bookings above for why a floor-less asset's
        // bookings must still be included (falling back to the org default tz).
        const orgDefaultTz = await resolveBuildingTimezone(prisma, null)
        rows = await prisma.$queryRaw<TopUserRow[]>`
          SELECT b."userId", u."displayName", u.email, COUNT(*)::bigint AS count
          FROM "Booking" b
          JOIN "User" u ON u.id = b."userId"
          LEFT JOIN "Asset" a ON a.id = b."assetId"
          LEFT JOIN "Floor" f ON f.id = a."floorId"
          LEFT JOIN "Building" bld ON bld.id = f."buildingId"
          WHERE ((b."startsAt" AT TIME ZONE 'UTC') AT TIME ZONE COALESCE(bld.timezone, ${orgDefaultTz})) >= ${startLocal}::timestamp
            AND ((b."startsAt" AT TIME ZONE 'UTC') AT TIME ZONE COALESCE(bld.timezone, ${orgDefaultTz})) <= ${endLocal}::timestamp
            AND b.status IN ('CONFIRMED', 'COMPLETED')
          GROUP BY b."userId", u."displayName", u.email
          ORDER BY count DESC
          LIMIT 20
        `
      }

      const data = rows.map((r) => ({
        userId: r.userId,
        displayName: r.displayName,
        email: r.email,
        bookingCount: Number(r.count),
      }))

      if (wantsCsv(request)) {
        return sendCsv(reply, 'top-users.csv', ['Name', 'Email', 'Bookings'], data.map((d) => [d.displayName, d.email, d.bookingCount]))
      }
      return reply.status(200).send({ data })
    },
  )

  // GET /analytics/departments — desk-days and booking counts grouped by department (SUPER_ADMIN only)
  fastify.get(
    '/departments',
    { preHandler: [requireAuth] },
    async (request, reply) => {
      if (request.user.globalRole !== GlobalRole.SUPER_ADMIN) {
        return reply.status(403).send({ error: { message: 'Forbidden', code: 'FORBIDDEN' } })
      }

      const result = analyticsQuerySchema.safeParse(request.query)
      if (!result.success) {
        return reply.status(400).send({ error: { message: 'Invalid query parameters', code: 'VALIDATION_ERROR' } })
      }

      const { startDateStr, endDateStr } = effectiveDateRangeStrings(result.data.startDate, result.data.endDate, 30)
      const { startLocal, endLocal } = localDayBoundsSql(startDateStr, endDateStr)

      type DeptRow = {
        departmentId: string
        departmentName: string
        bookingCount: bigint
        deskDays: string | null
        memberCount: bigint
      }

      // Every other report tab scopes to the selected building; this one
      // didn't reference result.data.buildingId at all and always queried the
      // whole org, silently ignoring the filter. Scoped inside the Booking
      // JOIN's own ON clause (not a WHERE) so it only narrows which bookings
      // count toward bookingCount/deskDays — memberCount (department
      // headcount) stays building-agnostic, and departments/users with no
      // matching booking are still preserved via the LEFT JOIN. The date
      // range itself is also evaluated in the ON clause (via a correlated
      // EXISTS against the booking_tz CTE, not a WHERE) for the same reason —
      // a WHERE on b."startsAt" would drop departments/users with zero
      // bookings entirely, since NULL never satisfies a comparison.
      const buildingFilter = result.data.buildingId
        ? Prisma.sql`AND EXISTS (
            SELECT 1 FROM "Asset" a JOIN "Floor" f ON f.id = a."floorId"
            WHERE a.id = b."assetId" AND f."buildingId" = ${result.data.buildingId}
          )`
        : Prisma.empty
      const orgDefaultTz = await resolveBuildingTimezone(prisma, null)

      const rows = await prisma.$queryRaw<DeptRow[]>`
        WITH booking_tz AS (
          SELECT b.id AS booking_id, COALESCE(bld.timezone, ${orgDefaultTz}) AS tz
          FROM "Booking" b
          LEFT JOIN "Asset" a ON a.id = b."assetId"
          LEFT JOIN "Floor" f ON f.id = a."floorId"
          LEFT JOIN "Building" bld ON bld.id = f."buildingId"
        )
        SELECT
          d.id                                                                         AS "departmentId",
          d.name                                                                       AS "departmentName",
          COUNT(DISTINCT b.id)::bigint                                                 AS "bookingCount",
          ROUND(
            CAST(
              COALESCE(SUM(EXTRACT(EPOCH FROM (b."endsAt" - b."startsAt")) / 3600 / 8), 0)
              AS NUMERIC
            ), 2
          )::text                                                                      AS "deskDays",
          COUNT(DISTINCT u.id)::bigint                                                 AS "memberCount"
        FROM "Department" d
        LEFT JOIN "User" u   ON u."departmentId" = d.id
        LEFT JOIN "Booking" b ON b."userId" = u.id
          AND b.status IN ('CONFIRMED', 'COMPLETED')
          AND EXISTS (
            SELECT 1 FROM booking_tz bt
            WHERE bt.booking_id = b.id
              AND ((b."startsAt" AT TIME ZONE 'UTC') AT TIME ZONE bt.tz) >= ${startLocal}::timestamp
              AND ((b."startsAt" AT TIME ZONE 'UTC') AT TIME ZONE bt.tz) <= ${endLocal}::timestamp
          )
          ${buildingFilter}
        GROUP BY d.id, d.name
        ORDER BY ROUND(
          CAST(
            COALESCE(SUM(EXTRACT(EPOCH FROM (b."endsAt" - b."startsAt")) / 3600 / 8), 0)
            AS NUMERIC
          ), 2
        ) DESC NULLS LAST
      `

      const data = rows.map((r) => ({
        departmentId: r.departmentId,
        departmentName: r.departmentName,
        bookingCount: Number(r.bookingCount),
        deskDays: Number(r.deskDays ?? 0),
        memberCount: Number(r.memberCount),
      }))

      if (wantsCsv(request)) {
        return sendCsv(reply, 'department-activity.csv',
          ['Department', 'Members', 'Bookings', 'Desk-Days'],
          data.map((d) => [d.departmentName, d.memberCount, d.bookingCount, d.deskDays]),
        )
      }
      return reply.status(200).send({ data })
    },
  )

  // GET /analytics/manager-rollup?userId= — aggregate bookings/desk-days for a
  // manager's entire reporting subtree, plus a per-direct-report breakdown.
  fastify.get(
    '/manager-rollup',
    { preHandler: [requireAuth] },
    async (request, reply) => {
      if (request.user.globalRole !== GlobalRole.SUPER_ADMIN) {
        return reply.status(403).send({ error: { message: 'Forbidden', code: 'FORBIDDEN' } })
      }
      const result = analyticsQuerySchema.extend({ userId: z.string().min(1) }).safeParse(request.query)
      if (!result.success) {
        return reply.status(400).send({ error: { message: 'userId and valid dates are required', code: 'VALIDATION_ERROR' } })
      }
      const { startDateStr, endDateStr } = effectiveDateRangeStrings(result.data.startDate, result.data.endDate, 30)
      const { startLocal, endLocal } = localDayBoundsSql(startDateStr, endDateStr)
      const userId = result.data.userId

      const root = await prisma.user.findUnique({ where: { id: userId }, select: { id: true, displayName: true, email: true } })
      if (!root) return reply.status(404).send({ error: { message: 'User not found', code: 'NOT_FOUND' } })

      // Every other report tab scopes to the selected building; this one
      // didn't reference result.data.buildingId at all and always rolled up
      // the whole subtree's activity org-wide. Scoped inside the Booking
      // JOIN's own ON clause (not a WHERE) so it only narrows which bookings
      // count toward bookingCount/deskDays — peopleCount (subtree headcount)
      // stays building-agnostic, and people with no matching booking are
      // still preserved via the LEFT JOIN. Same reasoning applies to the date
      // range itself (see /departments above for why it's a correlated EXISTS
      // against booking_tz, not a WHERE).
      const buildingFilter = result.data.buildingId
        ? Prisma.sql`AND EXISTS (
            SELECT 1 FROM "Asset" a JOIN "Floor" f ON f.id = a."floorId"
            WHERE a.id = b."assetId" AND f."buildingId" = ${result.data.buildingId}
          )`
        : Prisma.empty
      const orgDefaultTz = await resolveBuildingTimezone(prisma, null)
      const bookingTzCte = Prisma.sql`
        booking_tz AS (
          SELECT b.id AS booking_id, COALESCE(bld.timezone, ${orgDefaultTz}) AS tz
          FROM "Booking" b
          LEFT JOIN "Asset" a ON a.id = b."assetId"
          LEFT JOIN "Floor" f ON f.id = a."floorId"
          LEFT JOIN "Building" bld ON bld.id = f."buildingId"
        )
      `
      const dateRangeExists = Prisma.sql`
        AND EXISTS (
          SELECT 1 FROM booking_tz bt
          WHERE bt.booking_id = b.id
            AND ((b."startsAt" AT TIME ZONE 'UTC') AT TIME ZONE bt.tz) >= ${startLocal}::timestamp
            AND ((b."startsAt" AT TIME ZONE 'UTC') AT TIME ZONE bt.tz) <= ${endLocal}::timestamp
        )
      `

      type Totals = { peopleCount: bigint; bookingCount: bigint; deskDays: string | null }
      // UNION (not UNION ALL) so a manager cycle (A→B→A from bad IdP data) can't
      // recurse infinitely — duplicate ids are dropped, terminating traversal.
      const [overall] = await prisma.$queryRaw<Totals[]>`
        WITH RECURSIVE subtree AS (
          SELECT id FROM "User" WHERE id = ${userId}
          UNION
          SELECT u.id FROM "User" u JOIN subtree s ON u."managerId" = s.id
        ),
        ${bookingTzCte}
        SELECT
          COUNT(DISTINCT s.id)::bigint AS "peopleCount",
          COUNT(DISTINCT b.id)::bigint AS "bookingCount",
          ROUND(CAST(COALESCE(SUM(EXTRACT(EPOCH FROM (b."endsAt" - b."startsAt")) / 3600 / 8), 0) AS NUMERIC), 2)::text AS "deskDays"
        FROM subtree s
        LEFT JOIN "Booking" b ON b."userId" = s.id
          AND b.status IN ('CONFIRMED', 'COMPLETED')
          ${dateRangeExists}
          ${buildingFilter}
      `

      type BranchRow = Totals & { rootId: string; rootName: string }
      // UNION (see subtree CTE above) to guarantee termination on cyclic manager data.
      const branches = await prisma.$queryRaw<BranchRow[]>`
        WITH RECURSIVE branch AS (
          SELECT id, id AS root FROM "User" WHERE "managerId" = ${userId}
          UNION
          SELECT u.id, br.root FROM "User" u JOIN branch br ON u."managerId" = br.id
        ),
        ${bookingTzCte}
        SELECT
          br.root AS "rootId",
          ru."displayName" AS "rootName",
          COUNT(DISTINCT br.id)::bigint AS "peopleCount",
          COUNT(DISTINCT b.id)::bigint AS "bookingCount",
          ROUND(CAST(COALESCE(SUM(EXTRACT(EPOCH FROM (b."endsAt" - b."startsAt")) / 3600 / 8), 0) AS NUMERIC), 2)::text AS "deskDays"
        FROM branch br
        JOIN "User" ru ON ru.id = br.root
        LEFT JOIN "Booking" b ON b."userId" = br.id
          AND b.status IN ('CONFIRMED', 'COMPLETED')
          ${dateRangeExists}
          ${buildingFilter}
        GROUP BY br.root, ru."displayName"
        ORDER BY ROUND(CAST(COALESCE(SUM(EXTRACT(EPOCH FROM (b."endsAt" - b."startsAt")) / 3600 / 8), 0) AS NUMERIC), 2) DESC NULLS LAST
      `

      return reply.status(200).send({
        data: {
          manager: { id: root.id, displayName: root.displayName, email: root.email },
          peopleCount: Number(overall?.peopleCount ?? 0),
          bookingCount: Number(overall?.bookingCount ?? 0),
          deskDays: Number(overall?.deskDays ?? 0),
          directReports: branches.map((b) => ({
            rootId: b.rootId,
            rootName: b.rootName,
            peopleCount: Number(b.peopleCount),
            bookingCount: Number(b.bookingCount),
            deskDays: Number(b.deskDays ?? 0),
          })),
        },
      })
    },
  )

  // GET /capacity-planning — peak vs average daily attendance against
  // current desk capacity, per building (SUPER_ADMIN or building admin).
  // "Recommended desk count" is deliberately the observed peak-day count,
  // not the peak plus an arbitrary buffer — an invented buffer percentage
  // would be a made-up number this endpoint has no basis to pick; showing
  // the actual peak day lets an admin apply their own judgement/margin.
  fastify.get(
    '/capacity-planning',
    { preHandler: [requireAuth] },
    async (request, reply) => {
      const result = analyticsQuerySchema.safeParse(request.query)
      if (!result.success) return reply.status(400).send({ error: { message: 'Invalid query', code: 'VALIDATION_ERROR' } })

      const isSuperAdmin = request.user.globalRole === GlobalRole.SUPER_ADMIN
      let managedBuildingIds: string[] = []
      if (!isSuperAdmin) {
        managedBuildingIds = await getManagedBuildingIds(request.user.id)
        if (managedBuildingIds.length === 0) {
          return reply.status(403).send({ error: { message: 'Insufficient permissions', code: 'FORBIDDEN' } })
        }
        if (result.data.buildingId && !managedBuildingIds.includes(result.data.buildingId)) {
          return reply.status(403).send({ error: { message: 'Insufficient permissions', code: 'FORBIDDEN' } })
        }
      }

      const { startDateStr, endDateStr } = effectiveDateRangeStrings(result.data.startDate, result.data.endDate, 30)
      const { startLocal, endLocal } = localDayBoundsSql(startDateStr, endDateStr)
      const orgDefaultTz = await resolveBuildingTimezone(prisma, null)

      const buildingIdFilter = result.data.buildingId
        ? [result.data.buildingId]
        : !isSuperAdmin ? managedBuildingIds : null

      // Building is already always joined here (buildingName is selected
      // regardless of filter), so bld.timezone is available per row in both
      // branches — no LEFT JOIN/floor-less-asset concern the way /bookings
      // above has, since this endpoint is inherently building-scoped already.
      type DailyRow = { buildingId: string; buildingName: string; day: string; count: bigint }
      const dailyRows = buildingIdFilter
        ? await prisma.$queryRaw<DailyRow[]>`
            SELECT f."buildingId" AS "buildingId", bld.name AS "buildingName", DATE((b."startsAt" AT TIME ZONE 'UTC') AT TIME ZONE COALESCE(bld.timezone, ${orgDefaultTz})) AS day, COUNT(*)::bigint AS count
            FROM "Booking" b
            JOIN "Asset" a ON a.id = b."assetId"
            JOIN "Floor" f ON f.id = a."floorId"
            JOIN "Building" bld ON bld.id = f."buildingId"
            WHERE ((b."startsAt" AT TIME ZONE 'UTC') AT TIME ZONE COALESCE(bld.timezone, ${orgDefaultTz})) >= ${startLocal}::timestamp
              AND ((b."startsAt" AT TIME ZONE 'UTC') AT TIME ZONE COALESCE(bld.timezone, ${orgDefaultTz})) <= ${endLocal}::timestamp
              AND b.status IN ('CONFIRMED', 'COMPLETED') AND f."buildingId" = ANY(${buildingIdFilter})
            GROUP BY f."buildingId", bld.name, day
          `
        : await prisma.$queryRaw<DailyRow[]>`
            SELECT f."buildingId" AS "buildingId", bld.name AS "buildingName", DATE((b."startsAt" AT TIME ZONE 'UTC') AT TIME ZONE COALESCE(bld.timezone, ${orgDefaultTz})) AS day, COUNT(*)::bigint AS count
            FROM "Booking" b
            JOIN "Asset" a ON a.id = b."assetId"
            JOIN "Floor" f ON f.id = a."floorId"
            JOIN "Building" bld ON bld.id = f."buildingId"
            WHERE ((b."startsAt" AT TIME ZONE 'UTC') AT TIME ZONE COALESCE(bld.timezone, ${orgDefaultTz})) >= ${startLocal}::timestamp
              AND ((b."startsAt" AT TIME ZONE 'UTC') AT TIME ZONE COALESCE(bld.timezone, ${orgDefaultTz})) <= ${endLocal}::timestamp
              AND b.status IN ('CONFIRMED', 'COMPLETED')
            GROUP BY f."buildingId", bld.name, day
          `

      const byBuilding = new Map<string, { buildingName: string; days: number[] }>()
      for (const row of dailyRows) {
        const entry = byBuilding.get(row.buildingId) ?? { buildingName: row.buildingName, days: [] }
        entry.days.push(Number(row.count))
        byBuilding.set(row.buildingId, entry)
      }

      const deskCounts = await prisma.asset.groupBy({
        by: ['floorId'],
        where: {
          isBookable: true,
          bookingStatus: { in: ['OPEN', 'RESTRICTED', 'ASSIGNED'] },
          floor: buildingIdFilter ? { buildingId: { in: buildingIdFilter } } : undefined,
        },
        _count: { id: true },
      })
      const floorsToBuildings = await prisma.floor.findMany({
        where: { id: { in: deskCounts.map((d) => d.floorId).filter((id): id is string => id !== null) } },
        select: { id: true, buildingId: true },
      })
      const floorToBuilding = new Map(floorsToBuildings.map((f) => [f.id, f.buildingId]))
      const deskCountByBuilding = new Map<string, number>()
      for (const d of deskCounts) {
        if (!d.floorId) continue
        const buildingId = floorToBuilding.get(d.floorId)
        if (!buildingId) continue
        deskCountByBuilding.set(buildingId, (deskCountByBuilding.get(buildingId) ?? 0) + d._count.id)
      }

      // Days with zero bookings never produce a row from the GROUP BY query
      // above, so `days` only holds counts for days that had ≥1 booking.
      // The average must still be taken over the full requested range —
      // dividing by `days.length` instead silently drops zero-booking days
      // from the denominator too, overstating the average (a building
      // booked only on weekdays would report its weekday-only average as
      // if that were the whole period's average).
      // Midnight-to-midnight on both ends (not calendarDateObjects, whose
      // end value is 23:59:59.999 — mixing that with a midnight start would
      // over-count by one day for any range).
      const rangeStartMidnight = new Date(startDateStr + 'T00:00:00.000Z')
      const rangeEndMidnight = new Date(endDateStr + 'T00:00:00.000Z')
      const totalDaysInRange = Math.round((rangeEndMidnight.getTime() - rangeStartMidnight.getTime()) / 86_400_000) + 1

      const data = [...byBuilding.entries()].map(([buildingId, { buildingName, days }]) => {
        const peak = days.length > 0 ? Math.max(...days) : 0
        const average = totalDaysInRange > 0 ? Math.round((days.reduce((s, d) => s + d, 0) / totalDaysInRange) * 10) / 10 : 0
        const currentDeskCount = deskCountByBuilding.get(buildingId) ?? 0
        return {
          buildingId,
          buildingName,
          currentDeskCount,
          peakDailyAttendance: peak,
          averageDailyAttendance: average,
          recommendedDeskCount: peak,
          spareCapacity: Math.max(0, currentDeskCount - peak),
        }
      })

      if (wantsCsv(request)) {
        return sendCsv(reply, 'capacity-planning.csv',
          ['Building', 'Current Desks', 'Peak Daily Attendance', 'Average Daily Attendance', 'Recommended Desks', 'Spare Capacity'],
          data.map((d) => [d.buildingName, d.currentDeskCount, d.peakDailyAttendance, d.averageDailyAttendance, d.recommendedDeskCount, d.spareCapacity]),
        )
      }
      return reply.status(200).send({ data })
    },
  )

  // GET /utilisation-trend — month-over-month overall utilisation
  // (SUPER_ADMIN or building admin). Defaults to the last 6 months, unlike
  // every other endpoint's 30-day default — a single month of history
  // doesn't show a trend.
  fastify.get(
    '/utilisation-trend',
    { preHandler: [requireAuth] },
    async (request, reply) => {
      const result = analyticsQuerySchema.safeParse(request.query)
      if (!result.success) return reply.status(400).send({ error: { message: 'Invalid query', code: 'VALIDATION_ERROR' } })

      const isSuperAdmin = request.user.globalRole === GlobalRole.SUPER_ADMIN
      let managedBuildingIds: string[] = []
      if (!isSuperAdmin) {
        managedBuildingIds = await getManagedBuildingIds(request.user.id)
        if (managedBuildingIds.length === 0) {
          return reply.status(403).send({ error: { message: 'Insufficient permissions', code: 'FORBIDDEN' } })
        }
        if (result.data.buildingId && !managedBuildingIds.includes(result.data.buildingId)) {
          return reply.status(403).send({ error: { message: 'Insufficient permissions', code: 'FORBIDDEN' } })
        }
      }

      // Custom default (last 6 months, not the usual 30 days) — start of the
      // month 5 months before endDate's month, matching the previous
      // Date.UTC(endDate.getUTCFullYear(), endDate.getUTCMonth() - 5, 1) logic
      // exactly, just expressed as calendar-date strings.
      const today = new Date()
      const endDateStr = result.data.endDate ?? today.toISOString().slice(0, 10)
      let startDateStr: string
      if (result.data.startDate) {
        startDateStr = result.data.startDate
      } else {
        const [ey, em] = endDateStr.split('-').map(Number)
        startDateStr = new Date(Date.UTC(ey, em - 1 - 5, 1)).toISOString().slice(0, 10)
      }
      const { startLocal, endLocal } = localDayBoundsSql(startDateStr, endDateStr)
      const orgDefaultTz = await resolveBuildingTimezone(prisma, null)

      const buildingIdFilter = result.data.buildingId
        ? [result.data.buildingId]
        : !isSuperAdmin ? managedBuildingIds : null

      type MonthRow = { month: Date; count: bigint }
      const monthRows = buildingIdFilter
        ? await prisma.$queryRaw<MonthRow[]>`
            SELECT DATE_TRUNC('month', (b."startsAt" AT TIME ZONE 'UTC') AT TIME ZONE COALESCE(bld.timezone, ${orgDefaultTz})) AS month, COUNT(*)::bigint AS count
            FROM "Booking" b
            JOIN "Asset" a ON a.id = b."assetId"
            JOIN "Floor" f ON f.id = a."floorId"
            JOIN "Building" bld ON bld.id = f."buildingId"
            WHERE ((b."startsAt" AT TIME ZONE 'UTC') AT TIME ZONE COALESCE(bld.timezone, ${orgDefaultTz})) >= ${startLocal}::timestamp
              AND ((b."startsAt" AT TIME ZONE 'UTC') AT TIME ZONE COALESCE(bld.timezone, ${orgDefaultTz})) <= ${endLocal}::timestamp
              AND b.status IN ('CONFIRMED', 'COMPLETED') AND f."buildingId" = ANY(${buildingIdFilter})
            GROUP BY month
            ORDER BY month ASC
          `
        : await prisma.$queryRaw<MonthRow[]>`
            SELECT DATE_TRUNC('month', (b."startsAt" AT TIME ZONE 'UTC') AT TIME ZONE COALESCE(bld.timezone, ${orgDefaultTz})) AS month, COUNT(*)::bigint AS count
            FROM "Booking" b
            LEFT JOIN "Asset" a ON a.id = b."assetId"
            LEFT JOIN "Floor" f ON f.id = a."floorId"
            LEFT JOIN "Building" bld ON bld.id = f."buildingId"
            WHERE ((b."startsAt" AT TIME ZONE 'UTC') AT TIME ZONE COALESCE(bld.timezone, ${orgDefaultTz})) >= ${startLocal}::timestamp
              AND ((b."startsAt" AT TIME ZONE 'UTC') AT TIME ZONE COALESCE(bld.timezone, ${orgDefaultTz})) <= ${endLocal}::timestamp
              AND b.status IN ('CONFIRMED', 'COMPLETED')
            GROUP BY month
            ORDER BY month ASC
          `

      const assetBuildingFilter = buildingIdFilter ? { floor: { buildingId: { in: buildingIdFilter } } } : {}
      const [bookableDesks, assignedDesks] = await Promise.all([
        prisma.asset.count({ where: { isBookable: true, bookingStatus: { in: ['OPEN', 'RESTRICTED'] }, ...assetBuildingFilter } }),
        prisma.asset.count({ where: { isBookable: true, bookingStatus: 'ASSIGNED', ...assetBuildingFilter } }),
      ])
      const activeDesks = bookableDesks + assignedDesks

      const data = monthRows.map((row) => {
        const monthStart = new Date(row.month)
        const monthEnd = new Date(Date.UTC(monthStart.getUTCFullYear(), monthStart.getUTCMonth() + 1, 0, 23, 59, 59, 999))
        const workingDays = countWorkingDays(monthStart, monthEnd)
        const capacity = activeDesks * workingDays
        const bookingCount = Number(row.count)
        return {
          month: monthStart.toISOString().slice(0, 7),
          bookingCount,
          utilisationPct: capacity > 0 ? Math.round((bookingCount / capacity) * 100) : 0,
        }
      })

      if (wantsCsv(request)) {
        return sendCsv(reply, 'utilisation-trend.csv', ['Month', 'Bookings', 'Utilisation %'], data.map((d) => [d.month, d.bookingCount, d.utilisationPct]))
      }
      return reply.status(200).send({ data })
    },
  )

  // GET /cost-per-seat — lease cost per desk per day (SUPER_ADMIN or building
  // admin). Only meaningful for buildings with lease data — BuildingLease is
  // optional and admin-entered, so buildings without one are simply omitted
  // rather than shown with a misleading $0. rentAmount is treated as a
  // MONTHLY figure (the only assumption this can make — the schema doesn't
  // record a period) and divided by ~30 days; a building with several leases
  // uses the currently-active one (or the most recently started, if none is
  // currently active) rather than summing every lease it's ever had.
  fastify.get(
    '/cost-per-seat',
    { preHandler: [requireAuth] },
    async (request, reply) => {
      const result = analyticsQuerySchema.safeParse(request.query)
      if (!result.success) return reply.status(400).send({ error: { message: 'Invalid query', code: 'VALIDATION_ERROR' } })

      const isSuperAdmin = request.user.globalRole === GlobalRole.SUPER_ADMIN
      let managedBuildingIds: string[] = []
      if (!isSuperAdmin) {
        managedBuildingIds = await getManagedBuildingIds(request.user.id)
        if (managedBuildingIds.length === 0) {
          return reply.status(403).send({ error: { message: 'Insufficient permissions', code: 'FORBIDDEN' } })
        }
        if (result.data.buildingId && !managedBuildingIds.includes(result.data.buildingId)) {
          return reply.status(403).send({ error: { message: 'Insufficient permissions', code: 'FORBIDDEN' } })
        }
      }

      const buildingWhere: Record<string, unknown> = {}
      if (result.data.buildingId) buildingWhere.id = result.data.buildingId
      else if (!isSuperAdmin) buildingWhere.id = { in: managedBuildingIds }

      const buildings = await prisma.building.findMany({
        where: buildingWhere,
        select: {
          id: true,
          name: true,
          leases: {
            where: { rentAmount: { not: null } },
            orderBy: { startDate: 'desc' },
            select: { rentAmount: true, currency: true, startDate: true, endDate: true },
          },
          floors: {
            select: {
              assets: {
                where: { isBookable: true, bookingStatus: { in: ['OPEN', 'RESTRICTED', 'ASSIGNED'] } },
                select: { id: true },
              },
            },
          },
        },
      })

      const now = new Date()
      const data = (await Promise.all(buildings
        .map(async (b) => {
          // lease.startDate/endDate are date-only values (UTC midnight of an
          // admin-picked calendar day, same convention as leases.ts's
          // endDate), not real instants — classified via calendarDaysUntil
          // against the building's own timezone, the same fix leases.ts's
          // PUT handler and the lease-expiry cron already apply to this
          // exact field. Comparing them as raw instants against `now` (as
          // this used to) flips "active" a day early/late depending on the
          // building's UTC offset, near local midnight.
          const tz = await resolveBuildingTimezone(prisma, b.id)
          const active = b.leases.find((l) => {
            const daysUntilStart = calendarDaysUntil(l.startDate, now, tz)
            const daysUntilEnd = l.endDate ? calendarDaysUntil(l.endDate, now, tz) : null
            return daysUntilStart <= 0 && (daysUntilEnd === null || daysUntilEnd >= 0)
          }) ?? b.leases[0]
          const deskCount = b.floors.reduce((sum, f) => sum + f.assets.length, 0)
          if (!active || !active.rentAmount || deskCount === 0) return null
          const costPerSeatPerDay = Math.round((active.rentAmount / 30 / deskCount) * 100) / 100
          return {
            buildingId: b.id,
            buildingName: b.name,
            monthlyRent: active.rentAmount,
            currency: active.currency,
            deskCount,
            costPerSeatPerDay,
          }
        })))
        .filter((d): d is NonNullable<typeof d> => d !== null)

      if (wantsCsv(request)) {
        return sendCsv(reply, 'cost-per-seat.csv',
          ['Building', 'Monthly Rent', 'Currency', 'Desks', 'Cost Per Seat Per Day'],
          data.map((d) => [d.buildingName, d.monthlyRent, d.currency, d.deskCount, d.costPerSeatPerDay]),
        )
      }
      return reply.status(200).send({ data })
    },
  )
}
