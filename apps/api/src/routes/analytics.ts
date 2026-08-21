import type { FastifyInstance } from 'fastify'
import { Prisma } from '@prisma/client'
import { prisma } from '../lib/prisma.js'
import { GlobalRole } from '@roomer/shared'
import { requireAuth } from '../middleware/requireAuth.js'
import { getManagedBuildingIds } from '../middleware/requireRole.js'
import { wantsCsv, sendCsv } from '../lib/csv.js'
import { z } from 'zod'

const analyticsQuerySchema = z.object({
  startDate: z.string().optional(),
  endDate: z.string().optional(),
  buildingId: z.string().optional(),
  floorId: z.string().optional(),
})

function defaultDateRange(): { startDate: Date; endDate: Date } {
  const endDate = new Date()
  const startDate = new Date()
  startDate.setDate(startDate.getDate() - 30)
  return { startDate, endDate }
}

function parseDateParam(value: string | undefined, suffix: 'T00:00:00.000Z' | 'T23:59:59.999Z', fallback: Date): Date {
  return value ? new Date(value + suffix) : fallback
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

      const defaults = defaultDateRange()
      const startDate = parseDateParam(result.data.startDate, 'T00:00:00.000Z', defaults.startDate)
      const endDate = parseDateParam(result.data.endDate, 'T23:59:59.999Z', defaults.endDate)
      const workingDays = countWorkingDays(startDate, endDate)

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
                      status: 'CONFIRMED',
                      startsAt: { gte: startDate, lte: endDate },
                    },
                    select: { id: true },
                  },
                },
              },
            },
          },
        },
      })

      const data = floors.flatMap((floor) =>
        floor.zones.map((zone) => {
          const bookableDesks = zone.assets.filter((a) => a.bookingStatus === 'OPEN' || a.bookingStatus === 'RESTRICTED')
          const assignedDesks = zone.assets.filter((a) => a.bookingStatus === 'ASSIGNED')
          const disabledDesks = zone.assets.filter((a) => a.bookingStatus === 'DISABLED')
          const bookingCount = zone.assets.reduce((sum, a) => sum + a.bookings.length, 0)
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
      )

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

      const defaults = defaultDateRange()
      const startDate = parseDateParam(result.data.startDate, 'T00:00:00.000Z', defaults.startDate)
      const endDate = parseDateParam(result.data.endDate, 'T23:59:59.999Z', defaults.endDate)

      type BookingCountRow = { date: Date; count: bigint }

      let rows: BookingCountRow[]

      if (result.data.floorId) {
        rows = await prisma.$queryRaw<BookingCountRow[]>`
          SELECT DATE(b."startsAt") AS date, COUNT(*)::bigint AS count
          FROM "Booking" b
          JOIN "Asset" a ON a.id = b."assetId"
          WHERE b."startsAt" >= ${startDate}
            AND b."startsAt" <= ${endDate}
            AND b.status = 'CONFIRMED'
            AND a."floorId" = ${result.data.floorId}
          GROUP BY DATE(b."startsAt")
          ORDER BY DATE(b."startsAt") ASC
        `
      } else if (result.data.buildingId) {
        rows = await prisma.$queryRaw<BookingCountRow[]>`
          SELECT DATE(b."startsAt") AS date, COUNT(*)::bigint AS count
          FROM "Booking" b
          JOIN "Asset" a ON a.id = b."assetId"
          JOIN "Floor" f ON f.id = a."floorId"
          WHERE b."startsAt" >= ${startDate}
            AND b."startsAt" <= ${endDate}
            AND b.status = 'CONFIRMED'
            AND f."buildingId" = ${result.data.buildingId}
          GROUP BY DATE(b."startsAt")
          ORDER BY DATE(b."startsAt") ASC
        `
      } else if (!isSuperAdmin) {
        rows = await prisma.$queryRaw<BookingCountRow[]>`
          SELECT DATE(b."startsAt") AS date, COUNT(*)::bigint AS count
          FROM "Booking" b
          JOIN "Asset" a ON a.id = b."assetId"
          JOIN "Floor" f ON f.id = a."floorId"
          WHERE b."startsAt" >= ${startDate}
            AND b."startsAt" <= ${endDate}
            AND b.status = 'CONFIRMED'
            AND f."buildingId" = ANY(${managedBuildingIds})
          GROUP BY DATE(b."startsAt")
          ORDER BY DATE(b."startsAt") ASC
        `
      } else {
        rows = await prisma.$queryRaw<BookingCountRow[]>`
          SELECT DATE("startsAt") AS date, COUNT(*)::bigint AS count
          FROM "Booking"
          WHERE "startsAt" >= ${startDate}
            AND "startsAt" <= ${endDate}
            AND status = 'CONFIRMED'
          GROUP BY DATE("startsAt")
          ORDER BY DATE("startsAt") ASC
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

      const defaults = defaultDateRange()
      const startDate = parseDateParam(result.data.startDate, 'T00:00:00.000Z', defaults.startDate)
      const endDate = parseDateParam(result.data.endDate, 'T23:59:59.999Z', defaults.endDate)
      const workingDays = countWorkingDays(startDate, endDate)

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

      const bookingWhere: Record<string, unknown> = { startsAt: { gte: startDate, lte: endDate }, ...bookingBuildingFilter }

      const [confirmed, cancelled, noShowCount, completed, uniqueBookers, bookableDesks, assignedDesks, disabledDesks, queueDepth] = await Promise.all([
        prisma.booking.count({ where: { ...bookingWhere, status: 'CONFIRMED' } }),
        prisma.booking.count({ where: { ...bookingWhere, status: 'CANCELLED' } }),
        prisma.booking.count({ where: { ...bookingWhere, status: 'CANCELLED', noShow: true } }),
        prisma.booking.count({ where: { ...bookingWhere, status: 'COMPLETED' } }),
        prisma.booking.findMany({
          where: { ...bookingWhere, status: { in: ['CONFIRMED', 'COMPLETED'] } },
          select: { userId: true },
          distinct: ['userId'],
        }),
        // OPEN + RESTRICTED = freely bookable assets
        prisma.asset.count({ where: { isBookable: true, bookingStatus: { in: ['OPEN', 'RESTRICTED'] }, ...assetBuildingFilter } }),
        prisma.asset.count({ where: { isBookable: true, bookingStatus: 'ASSIGNED', ...assetBuildingFilter } }),
        prisma.asset.count({ where: { isBookable: true, bookingStatus: 'DISABLED', ...assetBuildingFilter } }),
        prisma.queueEntry.count({ where: { status: 'WAITING', ...queueBuildingFilter } }),
      ])

      const totalDesks = bookableDesks + assignedDesks + disabledDesks
      const totalAttempted = confirmed + cancelled + completed
      // "cancelled" includes no-show releases — separate them so each rate is distinct.
      const manualCancelled = Math.max(0, cancelled - noShowCount)
      const cancellationRate = totalAttempted > 0 ? Math.round((manualCancelled / totalAttempted) * 100) : 0
      const noShowRate = totalAttempted > 0 ? Math.round((noShowCount / totalAttempted) * 100) : 0
      // Capacity = all non-disabled desks (OPEN + RESTRICTED + ASSIGNED); disabled are truly out of service
      const activeDesks = bookableDesks + assignedDesks
      const totalCapacity = activeDesks * workingDays
      const overallUtilisationPct = totalCapacity > 0 ? Math.round((confirmed / totalCapacity) * 100) : 0

      return reply.status(200).send({
        data: {
          totalBookings: confirmed,
          cancelledBookings: manualCancelled,
          completedBookings: completed,
          cancellationRate,
          noShowBookings: noShowCount,
          noShowRate,
          uniqueBookers: uniqueBookers.length,
          avgDailyBookings: Math.round((confirmed / workingDays) * 10) / 10,
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

      const defaults = defaultDateRange()
      const startDate = result.data.startDate ? new Date(result.data.startDate + 'T00:00:00.000Z') : defaults.startDate
      const endDate = result.data.endDate ? new Date(result.data.endDate + 'T23:59:59.999Z') : defaults.endDate

      // Same gap as /summary above — result.data.buildingId was accepted but
      // never referenced, only the non-admin managed-buildings scope was ever applied.
      const buildingIdFilter = result.data.buildingId
        ? { in: [result.data.buildingId] }
        : !isSuperAdmin ? { in: managedBuildingIds } : undefined
      const buildingFilter = buildingIdFilter
        ? { asset: { floor: { buildingId: buildingIdFilter } } }
        : {}

      const [confirmed, cancelled, completed] = await Promise.all([
        prisma.booking.count({ where: { startsAt: { gte: startDate, lte: endDate }, status: 'CONFIRMED', ...buildingFilter } }),
        prisma.booking.count({ where: { startsAt: { gte: startDate, lte: endDate }, status: 'CANCELLED', ...buildingFilter } }),
        prisma.booking.count({ where: { startsAt: { gte: startDate, lte: endDate }, status: 'COMPLETED', ...buildingFilter } }),
      ])

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

      const defaults = defaultDateRange()
      const startDate = result.data.startDate ? new Date(result.data.startDate + 'T00:00:00.000Z') : defaults.startDate
      const endDate = result.data.endDate ? new Date(result.data.endDate + 'T23:59:59.999Z') : defaults.endDate

      // result.data.buildingId was accepted but never referenced — only the
      // super-admin/managed-buildings branches existed, so picking a specific
      // building in the Reports page filter silently did nothing.
      type DowRow = { dow: string; count: bigint }
      let rows: DowRow[]
      if (result.data.buildingId) {
        rows = await prisma.$queryRaw<DowRow[]>`
          SELECT EXTRACT(DOW FROM b."startsAt") AS dow, COUNT(*)::bigint AS count
          FROM "Booking" b
          JOIN "Asset" a ON a.id = b."assetId"
          JOIN "Floor" f ON f.id = a."floorId"
          WHERE b."startsAt" >= ${startDate}
            AND b."startsAt" <= ${endDate}
            AND b.status = 'CONFIRMED'
            AND f."buildingId" = ${result.data.buildingId}
          GROUP BY EXTRACT(DOW FROM b."startsAt")
          ORDER BY dow ASC
        `
      } else if (isSuperAdmin) {
        rows = await prisma.$queryRaw<DowRow[]>`
          SELECT EXTRACT(DOW FROM "startsAt") AS dow, COUNT(*)::bigint AS count
          FROM "Booking"
          WHERE "startsAt" >= ${startDate}
            AND "startsAt" <= ${endDate}
            AND status = 'CONFIRMED'
          GROUP BY EXTRACT(DOW FROM "startsAt")
          ORDER BY dow ASC
        `
      } else {
        rows = await prisma.$queryRaw<DowRow[]>`
          SELECT EXTRACT(DOW FROM b."startsAt") AS dow, COUNT(*)::bigint AS count
          FROM "Booking" b
          JOIN "Asset" a ON a.id = b."assetId"
          JOIN "Floor" f ON f.id = a."floorId"
          WHERE b."startsAt" >= ${startDate}
            AND b."startsAt" <= ${endDate}
            AND b.status = 'CONFIRMED'
            AND f."buildingId" = ANY(${managedBuildingIds})
          GROUP BY EXTRACT(DOW FROM b."startsAt")
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

      const defaults = defaultDateRange()
      const startDate = result.data.startDate ? new Date(result.data.startDate + 'T00:00:00.000Z') : defaults.startDate
      const endDate = result.data.endDate ? new Date(result.data.endDate + 'T23:59:59.999Z') : defaults.endDate

      const workingDays = countWorkingDays(startDate, endDate)

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
                    where: { status: 'CONFIRMED', startsAt: { gte: startDate, lte: endDate } },
                    select: { id: true },
                  },
                },
              },
            },
          },
        },
        orderBy: [{ building: { name: 'asc' } }, { name: 'asc' }],
      })

      const data = floors.map((floor) => {
        const allAssets = floor.zones.flatMap((z) => z.assets)
        const bookableDesks = allAssets.filter((a) => a.bookingStatus === 'OPEN' || a.bookingStatus === 'RESTRICTED').length
        const assignedDesks = allAssets.filter((a) => a.bookingStatus === 'ASSIGNED').length
        const disabledDesks = allAssets.filter((a) => a.bookingStatus === 'DISABLED').length
        const bookingCount = allAssets.reduce((s, a) => s + a.bookings.length, 0)
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
      })

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

      const defaults = defaultDateRange()
      const startDate = result.data.startDate ? new Date(result.data.startDate + 'T00:00:00.000Z') : defaults.startDate
      const endDate = result.data.endDate ? new Date(result.data.endDate + 'T23:59:59.999Z') : defaults.endDate

      type TopUserRow = { userId: string; displayName: string; email: string; count: bigint }

      let rows: TopUserRow[]

      if (result.data.floorId) {
        rows = await prisma.$queryRaw<TopUserRow[]>`
          SELECT b."userId", u."displayName", u.email, COUNT(*)::bigint AS count
          FROM "Booking" b
          JOIN "User" u ON u.id = b."userId"
          JOIN "Asset" a ON a.id = b."assetId"
          WHERE b."startsAt" >= ${startDate}
            AND b."startsAt" <= ${endDate}
            AND b.status = 'CONFIRMED'
            AND a."floorId" = ${result.data.floorId}
          GROUP BY b."userId", u."displayName", u.email
          ORDER BY count DESC
          LIMIT 20
        `
      } else if (result.data.buildingId) {
        rows = await prisma.$queryRaw<TopUserRow[]>`
          SELECT b."userId", u."displayName", u.email, COUNT(*)::bigint AS count
          FROM "Booking" b
          JOIN "User" u ON u.id = b."userId"
          JOIN "Asset" a ON a.id = b."assetId"
          JOIN "Floor" f ON f.id = a."floorId"
          WHERE b."startsAt" >= ${startDate}
            AND b."startsAt" <= ${endDate}
            AND b.status = 'CONFIRMED'
            AND f."buildingId" = ${result.data.buildingId}
          GROUP BY b."userId", u."displayName", u.email
          ORDER BY count DESC
          LIMIT 20
        `
      } else if (!isSuperAdmin) {
        rows = await prisma.$queryRaw<TopUserRow[]>`
          SELECT b."userId", u."displayName", u.email, COUNT(*)::bigint AS count
          FROM "Booking" b
          JOIN "User" u ON u.id = b."userId"
          JOIN "Asset" a ON a.id = b."assetId"
          JOIN "Floor" f ON f.id = a."floorId"
          WHERE b."startsAt" >= ${startDate}
            AND b."startsAt" <= ${endDate}
            AND b.status = 'CONFIRMED'
            AND f."buildingId" = ANY(${managedBuildingIds})
          GROUP BY b."userId", u."displayName", u.email
          ORDER BY count DESC
          LIMIT 20
        `
      } else {
        rows = await prisma.$queryRaw<TopUserRow[]>`
          SELECT b."userId", u."displayName", u.email, COUNT(*)::bigint AS count
          FROM "Booking" b
          JOIN "User" u ON u.id = b."userId"
          WHERE b."startsAt" >= ${startDate}
            AND b."startsAt" <= ${endDate}
            AND b.status = 'CONFIRMED'
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

      const { startDate: sd, endDate: ed } = defaultDateRange()
      const startDate = parseDateParam(result.data.startDate, 'T00:00:00.000Z', sd)
      const endDate = parseDateParam(result.data.endDate, 'T23:59:59.999Z', ed)

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
      // matching booking are still preserved via the LEFT JOIN.
      const buildingFilter = result.data.buildingId
        ? Prisma.sql`AND EXISTS (
            SELECT 1 FROM "Asset" a JOIN "Floor" f ON f.id = a."floorId"
            WHERE a.id = b."assetId" AND f."buildingId" = ${result.data.buildingId}
          )`
        : Prisma.empty

      const rows = await prisma.$queryRaw<DeptRow[]>`
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
          AND b."startsAt" >= ${startDate}
          AND b."startsAt" <= ${endDate}
          AND b.status = 'CONFIRMED'
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
      const { startDate: sd, endDate: ed } = defaultDateRange()
      const startDate = parseDateParam(result.data.startDate, 'T00:00:00.000Z', sd)
      const endDate = parseDateParam(result.data.endDate, 'T23:59:59.999Z', ed)
      const userId = result.data.userId

      const root = await prisma.user.findUnique({ where: { id: userId }, select: { id: true, displayName: true, email: true } })
      if (!root) return reply.status(404).send({ error: { message: 'User not found', code: 'NOT_FOUND' } })

      // Every other report tab scopes to the selected building; this one
      // didn't reference result.data.buildingId at all and always rolled up
      // the whole subtree's activity org-wide. Scoped inside the Booking
      // JOIN's own ON clause (not a WHERE) so it only narrows which bookings
      // count toward bookingCount/deskDays — peopleCount (subtree headcount)
      // stays building-agnostic, and people with no matching booking are
      // still preserved via the LEFT JOIN.
      const buildingFilter = result.data.buildingId
        ? Prisma.sql`AND EXISTS (
            SELECT 1 FROM "Asset" a JOIN "Floor" f ON f.id = a."floorId"
            WHERE a.id = b."assetId" AND f."buildingId" = ${result.data.buildingId}
          )`
        : Prisma.empty

      type Totals = { peopleCount: bigint; bookingCount: bigint; deskDays: string | null }
      // UNION (not UNION ALL) so a manager cycle (A→B→A from bad IdP data) can't
      // recurse infinitely — duplicate ids are dropped, terminating traversal.
      const [overall] = await prisma.$queryRaw<Totals[]>`
        WITH RECURSIVE subtree AS (
          SELECT id FROM "User" WHERE id = ${userId}
          UNION
          SELECT u.id FROM "User" u JOIN subtree s ON u."managerId" = s.id
        )
        SELECT
          COUNT(DISTINCT s.id)::bigint AS "peopleCount",
          COUNT(DISTINCT b.id)::bigint AS "bookingCount",
          ROUND(CAST(COALESCE(SUM(EXTRACT(EPOCH FROM (b."endsAt" - b."startsAt")) / 3600 / 8), 0) AS NUMERIC), 2)::text AS "deskDays"
        FROM subtree s
        LEFT JOIN "Booking" b ON b."userId" = s.id
          AND b."startsAt" >= ${startDate} AND b."startsAt" <= ${endDate} AND b.status = 'CONFIRMED'
          ${buildingFilter}
      `

      type BranchRow = Totals & { rootId: string; rootName: string }
      // UNION (see subtree CTE above) to guarantee termination on cyclic manager data.
      const branches = await prisma.$queryRaw<BranchRow[]>`
        WITH RECURSIVE branch AS (
          SELECT id, id AS root FROM "User" WHERE "managerId" = ${userId}
          UNION
          SELECT u.id, br.root FROM "User" u JOIN branch br ON u."managerId" = br.id
        )
        SELECT
          br.root AS "rootId",
          ru."displayName" AS "rootName",
          COUNT(DISTINCT br.id)::bigint AS "peopleCount",
          COUNT(DISTINCT b.id)::bigint AS "bookingCount",
          ROUND(CAST(COALESCE(SUM(EXTRACT(EPOCH FROM (b."endsAt" - b."startsAt")) / 3600 / 8), 0) AS NUMERIC), 2)::text AS "deskDays"
        FROM branch br
        JOIN "User" ru ON ru.id = br.root
        LEFT JOIN "Booking" b ON b."userId" = br.id
          AND b."startsAt" >= ${startDate} AND b."startsAt" <= ${endDate} AND b.status = 'CONFIRMED'
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

      const defaults = defaultDateRange()
      const startDate = parseDateParam(result.data.startDate, 'T00:00:00.000Z', defaults.startDate)
      const endDate = parseDateParam(result.data.endDate, 'T23:59:59.999Z', defaults.endDate)

      const buildingIdFilter = result.data.buildingId
        ? [result.data.buildingId]
        : !isSuperAdmin ? managedBuildingIds : null

      type DailyRow = { buildingId: string; buildingName: string; day: string; count: bigint }
      const dailyRows = buildingIdFilter
        ? await prisma.$queryRaw<DailyRow[]>`
            SELECT f."buildingId" AS "buildingId", bld.name AS "buildingName", DATE(b."startsAt") AS day, COUNT(*)::bigint AS count
            FROM "Booking" b
            JOIN "Asset" a ON a.id = b."assetId"
            JOIN "Floor" f ON f.id = a."floorId"
            JOIN "Building" bld ON bld.id = f."buildingId"
            WHERE b."startsAt" >= ${startDate} AND b."startsAt" <= ${endDate}
              AND b.status = 'CONFIRMED' AND f."buildingId" = ANY(${buildingIdFilter})
            GROUP BY f."buildingId", bld.name, DATE(b."startsAt")
          `
        : await prisma.$queryRaw<DailyRow[]>`
            SELECT f."buildingId" AS "buildingId", bld.name AS "buildingName", DATE(b."startsAt") AS day, COUNT(*)::bigint AS count
            FROM "Booking" b
            JOIN "Asset" a ON a.id = b."assetId"
            JOIN "Floor" f ON f.id = a."floorId"
            JOIN "Building" bld ON bld.id = f."buildingId"
            WHERE b."startsAt" >= ${startDate} AND b."startsAt" <= ${endDate} AND b.status = 'CONFIRMED'
            GROUP BY f."buildingId", bld.name, DATE(b."startsAt")
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

      const data = [...byBuilding.entries()].map(([buildingId, { buildingName, days }]) => {
        const peak = days.length > 0 ? Math.max(...days) : 0
        const average = days.length > 0 ? Math.round((days.reduce((s, d) => s + d, 0) / days.length) * 10) / 10 : 0
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

      const endDate = result.data.endDate ? new Date(result.data.endDate + 'T23:59:59.999Z') : new Date()
      const startDate = result.data.startDate
        ? new Date(result.data.startDate + 'T00:00:00.000Z')
        : new Date(Date.UTC(endDate.getUTCFullYear(), endDate.getUTCMonth() - 5, 1))

      const buildingIdFilter = result.data.buildingId
        ? [result.data.buildingId]
        : !isSuperAdmin ? managedBuildingIds : null

      type MonthRow = { month: Date; count: bigint }
      const monthRows = buildingIdFilter
        ? await prisma.$queryRaw<MonthRow[]>`
            SELECT DATE_TRUNC('month', b."startsAt") AS month, COUNT(*)::bigint AS count
            FROM "Booking" b
            JOIN "Asset" a ON a.id = b."assetId"
            JOIN "Floor" f ON f.id = a."floorId"
            WHERE b."startsAt" >= ${startDate} AND b."startsAt" <= ${endDate}
              AND b.status = 'CONFIRMED' AND f."buildingId" = ANY(${buildingIdFilter})
            GROUP BY DATE_TRUNC('month', b."startsAt")
            ORDER BY month ASC
          `
        : await prisma.$queryRaw<MonthRow[]>`
            SELECT DATE_TRUNC('month', "startsAt") AS month, COUNT(*)::bigint AS count
            FROM "Booking"
            WHERE "startsAt" >= ${startDate} AND "startsAt" <= ${endDate} AND status = 'CONFIRMED'
            GROUP BY DATE_TRUNC('month', "startsAt")
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
      const data = buildings
        .map((b) => {
          const active = b.leases.find((l) => l.startDate <= now && (!l.endDate || l.endDate >= now)) ?? b.leases[0]
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
        })
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
