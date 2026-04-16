import type { FastifyInstance } from 'fastify'
import { prisma } from '../lib/prisma'
import { createQueueEntrySchema, NotificationType } from '@roomer/shared'
import { requireAuth } from '../middleware/requireAuth'
import { enqueueNotification } from '../lib/queue'

export async function queueRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.addHook('onRoute', (route) => { route.schema = { tags: ['Queue'], ...route.schema } })

  // GET /queue — current user's WAITING and PROMOTED entries
  fastify.get('/', { preHandler: [requireAuth] }, async (request, reply) => {
    const entries = await prisma.queueEntry.findMany({
      where: {
        userId: request.user.id,
        status: { in: ['WAITING', 'PROMOTED'] },
      },
      include: {
        asset: {
          include: {
            primaryZone: {
              include: { floor: { include: { building: { select: { id: true, name: true } } } } },
            },
            floor: { include: { building: { select: { id: true, name: true } } } },
          },
        },
      },
      orderBy: { createdAt: 'asc' },
    })

    return reply.status(200).send({ data: entries })
  })

  // POST /queue — join queue
  fastify.post('/', { preHandler: [requireAuth] }, async (request, reply) => {
    const result = createQueueEntrySchema.safeParse(request.body)
    if (!result.success) {
      return reply.status(400).send({
        error: { message: 'Validation failed', code: 'VALIDATION_ERROR', details: result.error.flatten() },
      })
    }

    const { assetId, expiresAt } = result.data
    const wantedStartsAt = new Date(result.data.wantedStartsAt)
    const wantedEndsAt = new Date(result.data.wantedEndsAt)
    const expiresAtDate = new Date(expiresAt)

    const asset = await prisma.asset.findUnique({ where: { id: assetId } })
    if (!asset) {
      return reply.status(404).send({ error: { message: 'Asset not found', code: 'NOT_FOUND' } })
    }

    if (asset.bookingStatus === 'DISABLED') {
      return reply.status(409).send({ error: { message: 'Asset is disabled', code: 'ASSET_DISABLED' } })
    }

    // Check duplicate
    const existing = await prisma.queueEntry.findFirst({
      where: {
        userId: request.user.id,
        assetId,
        status: { in: ['WAITING', 'PROMOTED'] },
        wantedStartsAt: { lt: wantedEndsAt },
        wantedEndsAt: { gt: wantedStartsAt },
      },
    })

    if (existing) {
      return reply.status(409).send({
        error: { message: 'You already have a queue entry for this asset and period', code: 'ALREADY_QUEUED' },
      })
    }

    // Calculate position: count of WAITING entries for overlapping range + 1
    const position = await prisma.queueEntry.count({
      where: {
        assetId,
        status: 'WAITING',
        wantedStartsAt: { lt: wantedEndsAt },
        wantedEndsAt: { gt: wantedStartsAt },
      },
    })

    const entry = await prisma.queueEntry.create({
      data: {
        userId: request.user.id,
        assetId,
        wantedStartsAt,
        wantedEndsAt,
        expiresAt: expiresAtDate,
        position: position + 1,
        status: 'WAITING',
      },
      include: {
        asset: {
          include: {
            primaryZone: {
              include: { floor: { include: { building: { select: { id: true, name: true } } } } },
            },
            floor: { include: { building: { select: { id: true, name: true } } } },
          },
        },
      },
    })

    await enqueueNotification({
      type: NotificationType.QUEUE_JOINED,
      userId: request.user.id,
      queueEntryId: entry.id,
    })

    return reply.status(201).send({ data: entry })
  })

  // DELETE /queue/:id — leave queue
  fastify.delete('/:id', { preHandler: [requireAuth] }, async (request, reply) => {
    const { id } = request.params as { id: string }

    const entry = await prisma.queueEntry.findUnique({ where: { id } })
    if (!entry) {
      return reply.status(404).send({ error: { message: 'Queue entry not found', code: 'NOT_FOUND' } })
    }

    if (entry.userId !== request.user.id) {
      return reply.status(403).send({ error: { message: 'Forbidden', code: 'FORBIDDEN' } })
    }

    if (!['WAITING', 'PROMOTED'].includes(entry.status)) {
      return reply.status(409).send({
        error: { message: 'Queue entry cannot be cancelled in its current state', code: 'INVALID_STATUS' },
      })
    }

    await prisma.queueEntry.update({
      where: { id },
      data: { status: 'CANCELLED' },
    })

    return reply.status(200).send({ data: { ok: true } })
  })

  // POST /queue/:id/claim — claim promoted asset
  fastify.post('/:id/claim', { preHandler: [requireAuth] }, async (request, reply) => {
    const { id } = request.params as { id: string }

    const entry = await prisma.queueEntry.findUnique({
      where: { id },
      include: { asset: true },
    })

    if (!entry) {
      return reply.status(404).send({ error: { message: 'Queue entry not found', code: 'NOT_FOUND' } })
    }

    if (entry.userId !== request.user.id) {
      return reply.status(403).send({ error: { message: 'Forbidden', code: 'FORBIDDEN' } })
    }

    if (entry.status !== 'PROMOTED') {
      return reply.status(409).send({
        error: { message: 'Queue entry is not in PROMOTED state', code: 'INVALID_STATUS' },
      })
    }

    if (!entry.claimDeadline || entry.claimDeadline < new Date()) {
      return reply.status(409).send({
        error: { message: 'Claim deadline has passed', code: 'CLAIM_EXPIRED' },
      })
    }

    // Check asset is still free for the wanted period
    const conflict = await prisma.booking.findFirst({
      where: {
        assetId: entry.assetId,
        status: 'CONFIRMED',
        startsAt: { lt: entry.wantedEndsAt },
        endsAt: { gt: entry.wantedStartsAt },
      },
    })

    if (conflict) {
      return reply.status(409).send({
        error: { message: 'Asset is no longer available for this period', code: 'ASSET_CONFLICT' },
      })
    }

    // Create booking and mark entry as CLAIMED
    const [booking] = await prisma.$transaction([
      prisma.booking.create({
        data: {
          userId: request.user.id,
          assetId: entry.assetId,
          startsAt: entry.wantedStartsAt,
          endsAt: entry.wantedEndsAt,
          status: 'CONFIRMED',
        },
      }),
      prisma.queueEntry.update({
        where: { id },
        data: { status: 'CLAIMED' },
      }),
    ])

    await enqueueNotification({
      type: NotificationType.BOOKING_CONFIRMED,
      userId: request.user.id,
      bookingId: booking.id,
    })

    return reply.status(201).send({ data: { booking, queueEntry: { id, status: 'CLAIMED' } } })
  })
}
