import type { FastifyInstance } from 'fastify'
import { prisma } from '../lib/prisma'
import { GlobalRole } from '@roomer/shared'
import { requireAuth } from '../middleware/requireAuth'
import { requireGlobalRole } from '../middleware/requireRole'
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
  let days = 0
  const cursor = new Date(start)
  while (cursor <= end) {
    const d = cursor.getDay()
    if (d !== 0 && d !== 6) days++
    cursor.setDate(cursor.getDate() + 1)
  }
  return days || 1
}

export async function analyticsRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.addHook('onRoute', (route) => { route.schema = { tags: ['Analytics'], ...route.schema } })

  // GET /utilisation — desk utilisation by floor/zone for a date range
  fastify.get(
    '/utilisation',
    { preHandler: [requireAuth, requireGlobalRole(GlobalRole.SUPER_ADMIN)] },
    async (request, reply) => {
      const result = analyticsQuerySchema.safeParse(request.query)
      if (!result.success) {
        return reply.status(400).send({
          error: { message: 'Invalid query parameters', code: 'VALIDATION_ERROR' },
        })
      }

      const defaults = defaultDateRange()
      const startDate = parseDateParam(result.data.startDate, 'T00:00:00.000Z', defaults.startDate)
      const endDate = parseDateParam(result.data.endDate, 'T23:59:59.999Z', defaults.endDate)
      const workingDays = countWorkingDays(startDate, endDate)

      // Build floor/building filters
      const floorWhere: Record<string, unknown> = {}
      if (result.data.floorId) floorWhere.id = result.data.floorId
      if (result.data.buildingId) floorWhere.buildingId = result.data.buildingId

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

  // GET /bookings — booking counts by day for a date range
  fastify.get(
    '/bookings',
    { preHandler: [requireAuth, requireGlobalRole(GlobalRole.SUPER_ADMIN)] },
    async (request, reply) => {
      const result = analyticsQuerySchema.safeParse(request.query)
      if (!result.success) {
        return reply.status(400).send({
          error: { message: 'Invalid query parameters', code: 'VALIDATION_ERROR' },
        })
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

  // GET /summary — KPI summary stats
  fastify.get(
    '/summary',
    { preHandler: [requireAuth, requireGlobalRole(GlobalRole.SUPER_ADMIN)] },
    async (request, reply) => {
      const result = analyticsQuerySchema.safeParse(request.query)
      if (!result.success) return reply.status(400).send({ error: { message: 'Invalid query', code: 'VALIDATION_ERROR' } })

      const defaults = defaultDateRange()
      const startDate = parseDateParam(result.data.startDate, 'T00:00:00.000Z', defaults.startDate)
      const endDate = parseDateParam(result.data.endDate, 'T23:59:59.999Z', defaults.endDate)
      const workingDays = countWorkingDays(startDate, endDate)

      const bookingWhere: Record<string, unknown> = { startsAt: { gte: startDate, lte: endDate } }

      const [confirmed, cancelled, completed, uniqueBookers, bookableDesks, assignedDesks, disabledDesks, queueDepth] = await Promise.all([
        prisma.booking.count({ where: { ...bookingWhere, status: 'CONFIRMED' } }),
        prisma.booking.count({ where: { ...bookingWhere, status: 'CANCELLED' } }),
        prisma.booking.count({ where: { ...bookingWhere, status: 'COMPLETED' } }),
        prisma.booking.findMany({
          where: { ...bookingWhere, status: { in: ['CONFIRMED', 'COMPLETED'] } },
          select: { userId: true },
          distinct: ['userId'],
        }),
        // OPEN + RESTRICTED = freely bookable assets
        prisma.asset.count({ where: { isBookable: true, bookingStatus: { in: ['OPEN', 'RESTRICTED'] } } }),
        prisma.asset.count({ where: { isBookable: true, bookingStatus: 'ASSIGNED' } }),
        prisma.asset.count({ where: { isBookable: true, bookingStatus: 'DISABLED' } }),
        prisma.queueEntry.count({ where: { status: 'WAITING' } }),
      ])

      const totalDesks = bookableDesks + assignedDesks + disabledDesks
      const totalAttempted = confirmed + cancelled + completed
      const cancellationRate = totalAttempted > 0 ? Math.round((cancelled / totalAttempted) * 100) : 0
      // Capacity = all non-disabled desks (OPEN + RESTRICTED + ASSIGNED); disabled are truly out of service
      const activeDesks = bookableDesks + assignedDesks
      const totalCapacity = activeDesks * workingDays
      const overallUtilisationPct = totalCapacity > 0 ? Math.round((confirmed / totalCapacity) * 100) : 0

      return reply.status(200).send({
        data: {
          totalBookings: confirmed,
          cancelledBookings: cancelled,
          completedBookings: completed,
          cancellationRate,
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

  // GET /status-breakdown — booking counts by status
  fastify.get(
    '/status-breakdown',
    { preHandler: [requireAuth, requireGlobalRole(GlobalRole.SUPER_ADMIN)] },
    async (request, reply) => {
      const result = analyticsQuerySchema.safeParse(request.query)
      if (!result.success) return reply.status(400).send({ error: { message: 'Invalid query', code: 'VALIDATION_ERROR' } })

      const defaults = defaultDateRange()
      const startDate = result.data.startDate ? new Date(result.data.startDate + 'T00:00:00.000Z') : defaults.startDate
      const endDate = result.data.endDate ? new Date(result.data.endDate + 'T23:59:59.999Z') : defaults.endDate

      const [confirmed, cancelled, completed] = await Promise.all([
        prisma.booking.count({ where: { startsAt: { gte: startDate, lte: endDate }, status: 'CONFIRMED' } }),
        prisma.booking.count({ where: { startsAt: { gte: startDate, lte: endDate }, status: 'CANCELLED' } }),
        prisma.booking.count({ where: { startsAt: { gte: startDate, lte: endDate }, status: 'COMPLETED' } }),
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

  // GET /peak-days — bookings grouped by day of week
  fastify.get(
    '/peak-days',
    { preHandler: [requireAuth, requireGlobalRole(GlobalRole.SUPER_ADMIN)] },
    async (request, reply) => {
      const result = analyticsQuerySchema.safeParse(request.query)
      if (!result.success) return reply.status(400).send({ error: { message: 'Invalid query', code: 'VALIDATION_ERROR' } })

      const defaults = defaultDateRange()
      const startDate = result.data.startDate ? new Date(result.data.startDate + 'T00:00:00.000Z') : defaults.startDate
      const endDate = result.data.endDate ? new Date(result.data.endDate + 'T23:59:59.999Z') : defaults.endDate

      type DowRow = { dow: string; count: bigint }
      const rows = await prisma.$queryRaw<DowRow[]>`
        SELECT EXTRACT(DOW FROM "startsAt") AS dow, COUNT(*)::bigint AS count
        FROM "Booking"
        WHERE "startsAt" >= ${startDate}
          AND "startsAt" <= ${endDate}
          AND status = 'CONFIRMED'
        GROUP BY EXTRACT(DOW FROM "startsAt")
        ORDER BY dow ASC
      `

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

  // GET /floor-utilisation — floor-level aggregated utilisation
  fastify.get(
    '/floor-utilisation',
    { preHandler: [requireAuth, requireGlobalRole(GlobalRole.SUPER_ADMIN)] },
    async (request, reply) => {
      const result = analyticsQuerySchema.safeParse(request.query)
      if (!result.success) return reply.status(400).send({ error: { message: 'Invalid query', code: 'VALIDATION_ERROR' } })

      const defaults = defaultDateRange()
      const startDate = result.data.startDate ? new Date(result.data.startDate + 'T00:00:00.000Z') : defaults.startDate
      const endDate = result.data.endDate ? new Date(result.data.endDate + 'T23:59:59.999Z') : defaults.endDate

      let workingDays = 0
      const cursor = new Date(startDate)
      while (cursor <= endDate) {
        const day = cursor.getDay()
        if (day !== 0 && day !== 6) workingDays++
        cursor.setDate(cursor.getDate() + 1)
      }
      if (workingDays === 0) workingDays = 1

      const floorWhere: Record<string, unknown> = {}
      if (result.data.buildingId) floorWhere.buildingId = result.data.buildingId

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

  // GET /top-users — top users by booking count
  fastify.get(
    '/top-users',
    { preHandler: [requireAuth, requireGlobalRole(GlobalRole.SUPER_ADMIN)] },
    async (request, reply) => {
      const result = analyticsQuerySchema.safeParse(request.query)
      if (!result.success) {
        return reply.status(400).send({
          error: { message: 'Invalid query parameters', code: 'VALIDATION_ERROR' },
        })
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
}
