import type { FastifyInstance } from 'fastify'
import { Prisma } from '@prisma/client'
import { prisma } from '../lib/prisma.js'
import { GlobalRole } from '@roomer/shared'
import { requireAuth } from '../middleware/requireAuth.js'
import { getManagedBuildingIds } from '../middleware/requireRole.js'
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
                      startsAt: { gte: startDate },
                      endsAt: { lte: endDate },
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
      }

      const defaults = defaultDateRange()
      const startDate = parseDateParam(result.data.startDate, 'T00:00:00.000Z', defaults.startDate)
      const endDate = parseDateParam(result.data.endDate, 'T23:59:59.999Z', defaults.endDate)
      const workingDays = countWorkingDays(startDate, endDate)

      const bookingBuildingFilter = !isSuperAdmin
        ? { asset: { floor: { buildingId: { in: managedBuildingIds } } } }
        : {}
      const assetBuildingFilter = !isSuperAdmin
        ? { floor: { buildingId: { in: managedBuildingIds } } }
        : {}
      const queueBuildingFilter = !isSuperAdmin
        ? { asset: { floor: { buildingId: { in: managedBuildingIds } } } }
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
      }

      const defaults = defaultDateRange()
      const startDate = result.data.startDate ? new Date(result.data.startDate + 'T00:00:00.000Z') : defaults.startDate
      const endDate = result.data.endDate ? new Date(result.data.endDate + 'T23:59:59.999Z') : defaults.endDate

      const buildingFilter = !isSuperAdmin
        ? { asset: { floor: { buildingId: { in: managedBuildingIds } } } }
        : {}

      const [confirmed, cancelled, completed] = await Promise.all([
        prisma.booking.count({ where: { startsAt: { gte: startDate, lte: endDate }, status: 'CONFIRMED', ...buildingFilter } }),
        prisma.booking.count({ where: { startsAt: { gte: startDate, lte: endDate }, status: 'CANCELLED', ...buildingFilter } }),
        prisma.booking.count({ where: { startsAt: { gte: startDate, lte: endDate }, status: 'COMPLETED', ...buildingFilter } }),
      ])

      return reply.status(200).send({
        data: [
          { status: 'CONFIRMED', label: 'Confirmed', count: confirmed },
          { status: 'COMPLETED', label: 'Completed', count: completed },
          { status: 'CANCELLED', label: 'Cancelled', count: cancelled },
        ],
      })
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
      }

      const defaults = defaultDateRange()
      const startDate = result.data.startDate ? new Date(result.data.startDate + 'T00:00:00.000Z') : defaults.startDate
      const endDate = result.data.endDate ? new Date(result.data.endDate + 'T23:59:59.999Z') : defaults.endDate

      type DowRow = { dow: string; count: bigint }
      let rows: DowRow[]
      if (isSuperAdmin) {
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
                    where: { status: 'CONFIRMED', startsAt: { gte: startDate }, endsAt: { lte: endDate } },
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
}
