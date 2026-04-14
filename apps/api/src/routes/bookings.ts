import type { FastifyInstance } from 'fastify'
import { prisma } from '../lib/prisma'
import { createBookingSchema, updateBookingSchema, GlobalRole, NotificationType } from '@roomer/shared'
import { requireAuth } from '../middleware/requireAuth'
import { requireGlobalRole } from '../middleware/requireRole'
import { enqueueNotification } from '../lib/queue'
import { checkGroupAccess } from './groups'
import { z } from 'zod'

const reportQuerySchema = z.object({
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  userId: z.string().min(1).optional(),
  deskId: z.string().min(1).optional(),
  floorId: z.string().min(1).optional(),
  buildingId: z.string().min(1).optional(),
  status: z.enum(['CONFIRMED', 'CANCELLED', 'COMPLETED']).optional(),
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(100).default(20),
})

async function checkDeskOverlap(
  deskId: string,
  startsAt: Date,
  endsAt: Date,
  excludeBookingId?: string,
): Promise<boolean> {
  const conflict = await prisma.booking.findFirst({
    where: {
      deskId,
      status: 'CONFIRMED',
      id: excludeBookingId ? { not: excludeBookingId } : undefined,
      startsAt: { lt: endsAt },
      endsAt: { gt: startsAt },
    },
  })
  return conflict !== null
}

async function checkZoneGroupOverlap(
  userId: string,
  deskId: string,
  startsAt: Date,
  endsAt: Date,
  excludeBookingId?: string,
): Promise<boolean> {
  const desk = await prisma.desk.findUnique({
    where: { id: deskId },
    include: { zone: { include: { zoneGroup: true } } },
  })

  if (!desk?.zone.zoneGroupId) return false

  const conflict = await prisma.booking.findFirst({
    where: {
      userId,
      status: 'CONFIRMED',
      id: excludeBookingId ? { not: excludeBookingId } : undefined,
      startsAt: { lt: endsAt },
      endsAt: { gt: startsAt },
      desk: {
        zone: { zoneGroupId: desk.zone.zoneGroupId },
      },
    },
  })
  return conflict !== null
}

export async function bookingRoutes(fastify: FastifyInstance): Promise<void> {
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

      const { from, to, userId, deskId, floorId, buildingId, status, page, limit } = result.data
      const skip = (page - 1) * limit

      const where: Record<string, unknown> = {}
      if (status) where['status'] = status
      if (userId) where['userId'] = userId
      if (deskId) where['deskId'] = deskId
      if (from || to) {
        where['startsAt'] = {}
        if (from) (where['startsAt'] as Record<string, unknown>)['gte'] = new Date(from)
        if (to) (where['startsAt'] as Record<string, unknown>)['lte'] = new Date(to)
      }
      if (floorId) {
        where['desk'] = { zone: { floorId } }
      }
      if (buildingId) {
        where['desk'] = { zone: { floor: { buildingId } } }
      }

      const [bookings, total] = await Promise.all([
        prisma.booking.findMany({
          where,
          skip,
          take: limit,
          include: {
            user: { select: { id: true, displayName: true, email: true } },
            desk: {
              include: {
                zone: { include: { floor: { include: { building: { select: { id: true, name: true } } } } } },
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
    const { status } = request.query as { status?: string }
    const now = new Date()

    const where: Record<string, unknown> = { userId: request.user.id }

    if (status === 'past') {
      where['endsAt'] = { lt: now }
    } else if (status === 'all') {
      // No filter
    } else {
      // Default: upcoming
      where['endsAt'] = { gte: now }
      where['status'] = 'CONFIRMED'
    }

    const bookings = await prisma.booking.findMany({
      where,
      include: {
        desk: {
          include: { zone: { include: { floor: { include: { building: { select: { id: true, name: true } } } } } } },
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

    const { deskId, notes } = result.data
    const startsAt = new Date(result.data.startsAt)
    const endsAt = new Date(result.data.endsAt)

    const desk = await prisma.desk.findUnique({
      where: { id: deskId },
      include: {
        allowList: { select: { userId: true } },
        userAssignments: { select: { userId: true } },
        zone: { include: { floor: { select: { id: true, buildingId: true } } } },
      },
    })

    if (!desk) {
      return reply.status(404).send({ error: { message: 'Desk not found', code: 'NOT_FOUND' } })
    }

    if (desk.status === 'DISABLED') {
      return reply.status(409).send({ error: { message: 'Desk is disabled', code: 'DESK_DISABLED' } })
    }

    if (desk.status === 'RESTRICTED') {
      const onList = desk.allowList.some((e) => e.userId === request.user.id)
      if (!onList && request.user.globalRole !== 'SUPER_ADMIN') {
        return reply.status(403).send({ error: { message: 'You are not on the allow list for this desk', code: 'NOT_ON_ALLOW_LIST' } })
      }
    }

    if (desk.status === 'ASSIGNED') {
      const isAssignedUser = desk.userAssignments.some((ua) => ua.userId === request.user.id)
      if (!isAssignedUser && request.user.globalRole !== 'SUPER_ADMIN') {
        return reply.status(403).send({ error: { message: 'This desk is permanently assigned to another user', code: 'DESK_ASSIGNED' } })
      }
    }

    // Check group-based access restrictions (non-admins only)
    if (request.user.globalRole !== 'SUPER_ADMIN') {
      const allowed = await checkGroupAccess(
        request.user.id,
        desk.zone.floor.buildingId,
        desk.zone.floor.id,
      )
      if (!allowed) {
        return reply.status(403).send({
          error: { message: 'Your group does not have access to this building or floor', code: 'GROUP_ACCESS_DENIED' },
        })
      }
    }

    // Check desk overlap
    const deskConflict = await checkDeskOverlap(deskId, startsAt, endsAt)
    if (deskConflict) {
      return reply.status(409).send({ error: { message: 'Desk is already booked for this time', code: 'DESK_CONFLICT' } })
    }

    // Check zone group overlap
    const zoneGroupConflict = await checkZoneGroupOverlap(request.user.id, deskId, startsAt, endsAt)
    if (zoneGroupConflict) {
      return reply.status(409).send({
        error: { message: 'You already have a booking in the same zone group for this time', code: 'ZONE_GROUP_CONFLICT' },
      })
    }

    const booking = await prisma.booking.create({
      data: {
        userId: request.user.id,
        deskId,
        startsAt,
        endsAt,
        notes: notes ?? null,
        status: 'CONFIRMED',
      },
      include: {
        desk: {
          include: { zone: { include: { floor: { include: { building: { select: { id: true, name: true } } } } } } },
        },
      },
    })

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
        desk: {
          include: { zone: { include: { floor: { include: { building: { select: { id: true, name: true } } } } } } },
        },
      },
    })

    if (!booking) {
      return reply.status(404).send({ error: { message: 'Booking not found', code: 'NOT_FOUND' } })
    }

    // Only allow owner or super admin
    if (booking.userId !== request.user.id && request.user.globalRole !== 'SUPER_ADMIN') {
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

    if (booking.userId !== request.user.id && request.user.globalRole !== 'SUPER_ADMIN') {
      return reply.status(403).send({ error: { message: 'Forbidden', code: 'FORBIDDEN' } })
    }

    if (booking.status !== 'CONFIRMED') {
      return reply.status(409).send({ error: { message: 'Booking cannot be modified', code: 'BOOKING_NOT_MODIFIABLE' } })
    }

    const newStartsAt = result.data.startsAt ? new Date(result.data.startsAt) : booking.startsAt
    const newEndsAt = result.data.endsAt ? new Date(result.data.endsAt) : booking.endsAt

    const deskConflict = await checkDeskOverlap(booking.deskId, newStartsAt, newEndsAt, id)
    if (deskConflict) {
      return reply.status(409).send({ error: { message: 'Desk is already booked for this time', code: 'DESK_CONFLICT' } })
    }

    const zoneGroupConflict = await checkZoneGroupOverlap(booking.userId, booking.deskId, newStartsAt, newEndsAt, id)
    if (zoneGroupConflict) {
      return reply.status(409).send({
        error: { message: 'You already have a booking in the same zone group for this time', code: 'ZONE_GROUP_CONFLICT' },
      })
    }

    const updated = await prisma.booking.update({
      where: { id },
      data: {
        startsAt: newStartsAt,
        endsAt: newEndsAt,
        notes: result.data.notes !== undefined ? result.data.notes : booking.notes,
      },
    })

    return reply.status(200).send({ data: updated })
  })

  // DELETE /bookings/:id — cancel booking
  fastify.delete('/:id', { preHandler: [requireAuth] }, async (request, reply) => {
    const { id } = request.params as { id: string }

    const booking = await prisma.booking.findUnique({
      where: { id },
      include: { desk: { include: { zone: { select: { floorId: true } } } } },
    })
    if (!booking) {
      return reply.status(404).send({ error: { message: 'Booking not found', code: 'NOT_FOUND' } })
    }

    const isSelf = booking.userId === request.user.id
    const isAdmin = request.user.globalRole === 'SUPER_ADMIN'

    if (!isSelf && !isAdmin) {
      const floorId = booking.desk?.zone?.floorId
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
        deskId: booking.deskId,
        status: 'WAITING',
        wantedStartsAt: { lt: booking.endsAt },
        wantedEndsAt: { gt: booking.startsAt },
      },
      orderBy: { position: 'asc' },
    })

    if (nextQueued) {
      const claimDeadline = new Date(Date.now() + 2 * 60 * 60 * 1000) // +2h
      await prisma.queueEntry.update({
        where: { id: nextQueued.id },
        data: { status: 'PROMOTED', claimDeadline },
      })

      await enqueueNotification({
        type: NotificationType.QUEUE_PROMOTED,
        userId: nextQueued.userId,
        queueEntryId: nextQueued.id,
        claimDeadline: claimDeadline.toISOString(),
      })
    }

    return reply.status(200).send({ data: { ok: true } })
  })
}
