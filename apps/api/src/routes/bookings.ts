import type { FastifyInstance } from 'fastify'
import { Prisma } from '@prisma/client'
import { prisma } from '../lib/prisma'
import { createBookingSchema, updateBookingSchema, GlobalRole, NotificationType } from '@roomer/shared'
import { requireAuth } from '../middleware/requireAuth'
import { requireGlobalRole } from '../middleware/requireRole'
import { enqueueNotification, fanOutFloorAvailable } from '../lib/queue'
import { randomUUID } from 'crypto'
import { checkGroupAccess } from './groups'
import { z } from 'zod'

class BookingConflictError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message)
    this.name = 'BookingConflictError'
  }
}

const reportQuerySchema = z.object({
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  userId: z.string().min(1).optional(),
  assetId: z.string().min(1).optional(),
  floorId: z.string().min(1).optional(),
  buildingId: z.string().min(1).optional(),
  status: z.enum(['CONFIRMED', 'CANCELLED', 'COMPLETED']).optional(),
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(100).default(20),
})

async function checkAssetOverlap(
  tx: Prisma.TransactionClient,
  assetId: string,
  startsAt: Date,
  endsAt: Date,
  excludeBookingId?: string,
): Promise<boolean> {
  const conflict = await tx.booking.findFirst({
    where: {
      assetId,
      status: 'CONFIRMED',
      id: excludeBookingId ? { not: excludeBookingId } : undefined,
      startsAt: { lt: endsAt },
      endsAt: { gt: startsAt },
    },
  })
  return conflict !== null
}

async function checkZoneGroupOverlap(
  tx: Prisma.TransactionClient,
  userId: string,
  assetId: string,
  startsAt: Date,
  endsAt: Date,
  excludeBookingId?: string,
): Promise<boolean> {
  const asset = await tx.asset.findUnique({
    where: { id: assetId },
    select: {
      primaryZoneId: true,
      primaryZone: { select: { zoneGroupId: true } },
    },
  })

  const zoneGroupId = asset?.primaryZone?.zoneGroupId
  if (!zoneGroupId) return false

  const conflict = await tx.booking.findFirst({
    where: {
      userId,
      status: 'CONFIRMED',
      id: excludeBookingId ? { not: excludeBookingId } : undefined,
      startsAt: { lt: endsAt },
      endsAt: { gt: startsAt },
      asset: {
        primaryZone: { zoneGroupId },
      },
    },
  })
  return conflict !== null
}

export async function bookingRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.addHook('onRoute', (route) => { route.schema = { tags: ['Bookings'], ...route.schema } })

  // GET /bookings/report — admin paginated report (must be before /:id)
  fastify.get(
    '/report',
    { preHandler: [requireAuth, requireGlobalRole(GlobalRole.SUPER_ADMIN)] },
    async (request, reply) => {
      const result = reportQuerySchema.safeParse(request.query)
      if (!result.success) {
        return reply.status(400).send({
          error: { message: 'Invalid query parameters', code: 'VALIDATION_ERROR', details: result.error.flatten() },
        })
      }

      const { from, to, userId, assetId, floorId, buildingId, status, page, limit } = result.data
      const skip = (page - 1) * limit

      const where: Record<string, unknown> = {}
      if (status) where['status'] = status
      if (userId) where['userId'] = userId
      if (assetId) where['assetId'] = assetId
      if (from || to) {
        where['startsAt'] = {}
        if (from) (where['startsAt'] as Record<string, unknown>)['gte'] = new Date(from)
        if (to) (where['startsAt'] as Record<string, unknown>)['lte'] = new Date(to)
      }
      if (floorId) {
        where['asset'] = { floorId }
      }
      if (buildingId) {
        where['asset'] = { floor: { buildingId } }
      }

      const [bookings, total] = await Promise.all([
        prisma.booking.findMany({
          where,
          skip,
          take: limit,
          include: {
            user: { select: { id: true, displayName: true, email: true } },
            asset: {
              include: {
                floor: { include: { building: { select: { id: true, name: true } } } },
                primaryZone: { select: { id: true, name: true } },
              },
            },
          },
          orderBy: { startsAt: 'desc' },
        }),
        prisma.booking.count({ where }),
      ])

      return reply.status(200).send({
        data: bookings,
        meta: { page, limit, total, totalPages: Math.ceil(total / limit) },
      })
    },
  )

  // GET /bookings — current user's bookings
  fastify.get('/', { preHandler: [requireAuth] }, async (request, reply) => {
    const queryResult = z.object({ status: z.enum(['past', 'all', 'upcoming']).optional() }).safeParse(request.query)
    if (!queryResult.success) {
      return reply.status(400).send({ error: { message: 'Invalid query parameters', code: 'VALIDATION_ERROR' } })
    }
    const { status } = queryResult.data
    const now = new Date()
    const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate())

    const where: Record<string, unknown> = { userId: request.user.id }

    if (status === 'past') {
      where['endsAt'] = { lt: startOfToday }
    } else if (status === 'all') {
      // No filter
    } else {
      // Default: upcoming — include all of today regardless of time
      where['endsAt'] = { gte: startOfToday }
      where['status'] = 'CONFIRMED'
    }

    const bookings = await prisma.booking.findMany({
      where,
      include: {
        asset: {
          include: {
            floor: { include: { building: { select: { id: true, name: true } } } },
            primaryZone: { select: { id: true, name: true } },
          },
        },
      },
      orderBy: { startsAt: 'asc' },
    })

    return reply.status(200).send({ data: bookings, meta: { total: bookings.length } })
  })

  // POST /bookings — create booking
  fastify.post('/', { preHandler: [requireAuth] }, async (request, reply) => {
    const result = createBookingSchema.safeParse(request.body)
    if (!result.success) {
      return reply.status(400).send({
        error: { message: 'Validation failed', code: 'VALIDATION_ERROR', details: result.error.flatten() },
      })
    }

    const { assetId, notes } = result.data
    const startsAt = new Date(result.data.startsAt)
    const endsAt = new Date(result.data.endsAt)

    const asset = await prisma.asset.findUnique({
      where: { id: assetId },
      include: {
        allowList: { select: { userId: true } },
        userAssignments: { select: { userId: true } },
        floor: { select: { id: true, buildingId: true } },
      },
    })

    if (!asset) {
      return reply.status(404).send({ error: { message: 'Asset not found', code: 'NOT_FOUND' } })
    }

    if (!asset.isBookable) {
      return reply.status(409).send({ error: { message: 'Asset is not bookable', code: 'ASSET_NOT_BOOKABLE' } })
    }

    if (asset.bookingStatus === 'DISABLED') {
      return reply.status(409).send({ error: { message: 'Asset is disabled', code: 'ASSET_DISABLED' } })
    }

    if (asset.bookingStatus === 'RESTRICTED') {
      const onList = asset.allowList.some((e) => e.userId === request.user.id)
      const isAssigned = asset.userAssignments.some((ua) => ua.userId === request.user.id)
      if (!onList && !isAssigned && request.user.globalRole !== GlobalRole.SUPER_ADMIN) {
        return reply.status(403).send({ error: { message: 'You are not on the allow list for this asset', code: 'NOT_ON_ALLOW_LIST' } })
      }
    }

    if (asset.bookingStatus === 'ASSIGNED') {
      const isAssignedUser = asset.userAssignments.some((ua) => ua.userId === request.user.id)
      if (!isAssignedUser && request.user.globalRole !== GlobalRole.SUPER_ADMIN) {
        // Allow if there is an active availability window covering the requested slot
        const window = await prisma.assetAvailabilityWindow.findFirst({
          where: {
            assetId,
            startsAt: { lte: startsAt },
            endsAt: { gte: endsAt },
          },
        })
        if (!window) {
          return reply.status(403).send({ error: { message: 'This asset is permanently assigned to another user', code: 'ASSET_ASSIGNED' } })
        }
      }
    }

    // Check group-based access restrictions (non-admins only)
    if (request.user.globalRole !== GlobalRole.SUPER_ADMIN && asset.floor) {
      const allowed = await checkGroupAccess(
        request.user.id,
        asset.floor.buildingId,
        asset.floor.id,
      )
      if (!allowed) {
        return reply.status(403).send({
          error: { message: 'Your group does not have access to this building or floor', code: 'GROUP_ACCESS_DENIED' },
        })
      }
    }

    let booking: Awaited<ReturnType<typeof prisma.booking.create>>
    try {
      booking = await prisma.$transaction(async (tx) => {
        // Serialize concurrent bookings for the same asset using an advisory lock
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(1, hashtext(${assetId}))`

        if (await checkAssetOverlap(tx, assetId, startsAt, endsAt)) {
          throw new BookingConflictError('ASSET_CONFLICT', 'Asset is already booked for this time')
        }

        if (await checkZoneGroupOverlap(tx, request.user.id, assetId, startsAt, endsAt)) {
          throw new BookingConflictError('ZONE_GROUP_CONFLICT', 'You already have a booking in the same zone group for this time')
        }

        return tx.booking.create({
          data: {
            userId: request.user.id,
            assetId,
            startsAt,
            endsAt,
            notes: notes ?? null,
            status: 'CONFIRMED',
          },
          include: {
            asset: {
              include: {
                floor: { include: { building: { select: { id: true, name: true } } } },
                primaryZone: { select: { id: true, name: true } },
              },
            },
          },
        })
      })
    } catch (err) {
      if (err instanceof BookingConflictError) {
        return reply.status(409).send({ error: { message: err.message, code: err.code } })
      }
      throw err
    }

    await enqueueNotification({
      type: NotificationType.BOOKING_CONFIRMED,
      userId: request.user.id,
      bookingId: booking.id,
    })

    return reply.status(201).send({ data: booking })
  })

  // GET /bookings/:id — single booking
  fastify.get('/:id', { preHandler: [requireAuth] }, async (request, reply) => {
    const { id } = request.params as { id: string }

    const booking = await prisma.booking.findUnique({
      where: { id },
      include: {
        user: { select: { id: true, displayName: true, email: true } },
        asset: {
          include: {
            floor: { include: { building: { select: { id: true, name: true } } } },
            primaryZone: { select: { id: true, name: true } },
          },
        },
      },
    })

    if (!booking) {
      return reply.status(404).send({ error: { message: 'Booking not found', code: 'NOT_FOUND' } })
    }

    // Only allow owner or super admin
    if (booking.userId !== request.user.id && request.user.globalRole !== GlobalRole.SUPER_ADMIN) {
      return reply.status(403).send({ error: { message: 'Forbidden', code: 'FORBIDDEN' } })
    }

    return reply.status(200).send({ data: booking })
  })

  // PATCH /bookings/:id — modify booking
  fastify.patch('/:id', { preHandler: [requireAuth] }, async (request, reply) => {
    const { id } = request.params as { id: string }
    const result = updateBookingSchema.safeParse(request.body)
    if (!result.success) {
      return reply.status(400).send({
        error: { message: 'Validation failed', code: 'VALIDATION_ERROR', details: result.error.flatten() },
      })
    }

    const booking = await prisma.booking.findUnique({ where: { id } })
    if (!booking) {
      return reply.status(404).send({ error: { message: 'Booking not found', code: 'NOT_FOUND' } })
    }

    if (booking.userId !== request.user.id && request.user.globalRole !== GlobalRole.SUPER_ADMIN) {
      return reply.status(403).send({ error: { message: 'Forbidden', code: 'FORBIDDEN' } })
    }

    if (booking.status !== 'CONFIRMED') {
      return reply.status(409).send({ error: { message: 'Booking cannot be modified', code: 'BOOKING_NOT_MODIFIABLE' } })
    }

    const newStartsAt = result.data.startsAt ? new Date(result.data.startsAt) : booking.startsAt
    const newEndsAt = result.data.endsAt ? new Date(result.data.endsAt) : booking.endsAt

    let updated: Awaited<ReturnType<typeof prisma.booking.update>>
    try {
      updated = await prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(1, hashtext(${booking.assetId}))`

        if (await checkAssetOverlap(tx, booking.assetId, newStartsAt, newEndsAt, id)) {
          throw new BookingConflictError('ASSET_CONFLICT', 'Asset is already booked for this time')
        }

        if (await checkZoneGroupOverlap(tx, booking.userId, booking.assetId, newStartsAt, newEndsAt, id)) {
          throw new BookingConflictError('ZONE_GROUP_CONFLICT', 'You already have a booking in the same zone group for this time')
        }

        return tx.booking.update({
          where: { id },
          data: {
            startsAt: newStartsAt,
            endsAt: newEndsAt,
            notes: result.data.notes !== undefined ? result.data.notes : booking.notes,
          },
        })
      })
    } catch (err) {
      if (err instanceof BookingConflictError) {
        return reply.status(409).send({ error: { message: err.message, code: err.code } })
      }
      throw err
    }

    return reply.status(200).send({ data: updated })
  })

  // DELETE /bookings/:id — cancel booking
  fastify.delete('/:id', { preHandler: [requireAuth] }, async (request, reply) => {
    const { id } = request.params as { id: string }

    const booking = await prisma.booking.findUnique({
      where: { id },
      include: { asset: { select: { floorId: true } } },
    })
    if (!booking) {
      return reply.status(404).send({ error: { message: 'Booking not found', code: 'NOT_FOUND' } })
    }

    const isSelf = booking.userId === request.user.id
    const isAdmin = request.user.globalRole === GlobalRole.SUPER_ADMIN

    if (!isSelf && !isAdmin) {
      const floorId = booking.asset?.floorId
      const directRole = floorId
        ? await prisma.userResourceRole.findFirst({
            where: { userId: request.user.id, scopeType: 'FLOOR', floorId },
          })
        : null
      const groupRole = (!directRole && floorId)
        ? await prisma.groupResourceRole.findFirst({
            where: {
              scopeType: 'FLOOR',
              floorId,
              group: { members: { some: { userId: request.user.id } } },
            },
          })
        : null
      if (!directRole && !groupRole) {
        return reply.status(403).send({ error: { message: 'Forbidden', code: 'FORBIDDEN' } })
      }
    }

    if (booking.status !== 'CONFIRMED') {
      return reply.status(409).send({ error: { message: 'Booking is not active', code: 'BOOKING_NOT_ACTIVE' } })
    }

    // Cancel the booking
    await prisma.booking.update({ where: { id }, data: { status: 'CANCELLED' } })

    // Notify the original booker
    const notificationType = !isSelf
      ? NotificationType.BOOKING_CANCELLED_BY_ADMIN
      : NotificationType.BOOKING_CANCELLED

    await enqueueNotification({
      type: notificationType,
      userId: booking.userId,
      bookingId: id,
    })

    // Promote next queue entry for overlapping slot
    const nextQueued = await prisma.queueEntry.findFirst({
      where: {
        assetId: booking.assetId,
        status: 'WAITING',
        wantedStartsAt: { lt: booking.endsAt },
        wantedEndsAt: { gt: booking.startsAt },
      },
      orderBy: { position: 'asc' },
    })

    if (nextQueued) {
      const claimDeadline = new Date(Date.now() + 2 * 60 * 60 * 1000) // +2h
      const claimToken = randomUUID()
      await prisma.queueEntry.update({
        where: { id: nextQueued.id },
        data: { status: 'PROMOTED', claimDeadline, claimToken },
      })

      await enqueueNotification({
        type: NotificationType.QUEUE_PROMOTED,
        userId: nextQueued.userId,
        queueEntryId: nextQueued.id,
        claimDeadline: claimDeadline.toISOString(),
      })
    }

    // Notify floor subscribers of the newly-freed slot
    const cancelledAsset = await prisma.asset.findUnique({
      where: { id: booking.assetId },
      select: { floorId: true, primaryZoneId: true },
    })
    if (cancelledAsset?.floorId) {
      const slotDate = booking.startsAt.toISOString().slice(0, 10)
      await fanOutFloorAvailable(
        booking.assetId,
        cancelledAsset.floorId,
        cancelledAsset.primaryZoneId,
        slotDate,
        booking.userId,
      ).catch((err) => console.error('[bookings] floor fan-out error:', err))
    }

    return reply.status(200).send({ data: { ok: true } })
  })
}
