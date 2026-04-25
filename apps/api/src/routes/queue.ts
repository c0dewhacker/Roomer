import type { FastifyInstance } from 'fastify'
import { prisma } from '../lib/prisma'
import { createQueueEntrySchema, NotificationType, GlobalRole } from '@roomer/shared'
import { requireAuth } from '../middleware/requireAuth'
import { enqueueNotification } from '../lib/queue'
import { randomUUID } from 'crypto'
import { checkGroupAccess } from './groups'
import { z } from 'zod'

export async function queueRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.addHook('onRoute', (route) => { route.schema = { tags: ['Queue'], ...route.schema } })

  // GET /queue — current user's queue entries. Active only by default; ?include_history=true adds terminal entries.
  fastify.get('/', { preHandler: [requireAuth] }, async (request, reply) => {
    const queryResult = z.object({ include_history: z.enum(['true', 'false']).optional() }).safeParse(request.query)
    if (!queryResult.success) {
      return reply.status(400).send({ error: { message: 'Invalid query parameters', code: 'VALIDATION_ERROR' } })
    }
    const { include_history } = queryResult.data
    const statusFilter: { in: Array<'WAITING' | 'PROMOTED'> } | undefined = include_history === 'true'
      ? undefined
      : { in: ['WAITING', 'PROMOTED'] }

    const entries = await prisma.queueEntry.findMany({
      where: {
        userId: request.user.id,
        ...(statusFilter ? { status: statusFilter } : {}),
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
      orderBy: { createdAt: 'desc' },
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

    const asset = await prisma.asset.findUnique({ where: { id: assetId }, include: { floor: true } })
    if (!asset) {
      return reply.status(404).send({ error: { message: 'Asset not found', code: 'NOT_FOUND' } })
    }

    if (request.user.globalRole !== GlobalRole.SUPER_ADMIN && asset.floor) {
      const allowed = await checkGroupAccess(request.user.id, asset.floor.buildingId, asset.floor.id)
      if (!allowed) {
        return reply.status(403).send({ error: { message: 'Your group does not have access to this building or floor', code: 'GROUP_ACCESS_DENIED' } })
      }
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

    // Count + create in one transaction with advisory lock to prevent position race
    const entry = await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(2, hashtext(${assetId}))`

      const position = await tx.queueEntry.count({
        where: {
          assetId,
          status: 'WAITING',
          wantedStartsAt: { lt: wantedEndsAt },
          wantedEndsAt: { gt: wantedStartsAt },
        },
      })

      return tx.queueEntry.create({
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

    // Compact positions: decrement all WAITING entries for the same asset/period that were behind the cancelled one
    await prisma.queueEntry.updateMany({
      where: {
        assetId: entry.assetId,
        status: 'WAITING',
        position: { gt: entry.position },
        wantedStartsAt: { lt: entry.wantedEndsAt },
        wantedEndsAt: { gt: entry.wantedStartsAt },
      },
      data: { position: { decrement: 1 } },
    })

    return reply.status(200).send({ data: { ok: true } })
  })

  // POST /queue/claim-by-token — one-click claim via email link (no auth required)
  fastify.post('/claim-by-token', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (request, reply) => {
    const { token } = request.body as { token?: string }
    if (!token || typeof token !== 'string') {
      return reply.status(400).send({ error: { message: 'Token is required', code: 'VALIDATION_ERROR' } })
    }

    const entry = await prisma.queueEntry.findUnique({
      where: { claimToken: token },
      include: { asset: true },
    })

    if (!entry) {
      return reply.status(404).send({ error: { message: 'Invalid or already-used token', code: 'TOKEN_INVALID' } })
    }

    if (entry.status !== 'PROMOTED') {
      return reply.status(409).send({ error: { message: 'This booking has already been claimed or expired', code: 'ALREADY_CLAIMED' } })
    }

    if (!entry.claimDeadline || entry.claimDeadline < new Date()) {
      return reply.status(409).send({ error: { message: 'Claim deadline has passed', code: 'TOKEN_EXPIRED' } })
    }

    const result = await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(2, hashtext(${entry.assetId}))`

      const conflict = await tx.booking.findFirst({
        where: {
          assetId: entry.assetId,
          status: 'CONFIRMED',
          startsAt: { lt: entry.wantedEndsAt },
          endsAt: { gt: entry.wantedStartsAt },
        },
      })
      if (conflict) return null

      const booking = await tx.booking.create({
        data: {
          userId: entry.userId,
          assetId: entry.assetId,
          startsAt: entry.wantedStartsAt,
          endsAt: entry.wantedEndsAt,
          status: 'CONFIRMED',
        },
      })
      await tx.queueEntry.update({
        where: { id: entry.id },
        data: { status: 'CLAIMED', claimToken: null },
      })
      return booking
    })

    if (!result) {
      return reply.status(409).send({
        error: { message: 'Asset is no longer available for this period', code: 'ASSET_CONFLICT' },
      })
    }

    await enqueueNotification({
      type: NotificationType.BOOKING_CONFIRMED,
      userId: entry.userId,
      bookingId: result.id,
    })

    return reply.status(201).send({ data: { booking: result, queueEntry: { id: entry.id, status: 'CLAIMED' } } })
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

    // Serialize on the asset ID, then check availability and create booking atomically
    const booking = await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(2, hashtext(${entry.assetId}))`

      const conflict = await tx.booking.findFirst({
        where: {
          assetId: entry.assetId,
          status: 'CONFIRMED',
          startsAt: { lt: entry.wantedEndsAt },
          endsAt: { gt: entry.wantedStartsAt },
        },
      })
      if (conflict) return null

      const created = await tx.booking.create({
        data: {
          userId: request.user.id,
          assetId: entry.assetId,
          startsAt: entry.wantedStartsAt,
          endsAt: entry.wantedEndsAt,
          status: 'CONFIRMED',
        },
      })
      await tx.queueEntry.update({
        where: { id },
        data: { status: 'CLAIMED', claimToken: null },
      })
      return created
    })

    if (!booking) {
      return reply.status(409).send({
        error: { message: 'Asset is no longer available for this period', code: 'ASSET_CONFLICT' },
      })
    }

    await enqueueNotification({
      type: NotificationType.BOOKING_CONFIRMED,
      userId: request.user.id,
      bookingId: booking.id,
    })

    return reply.status(201).send({ data: { booking, queueEntry: { id, status: 'CLAIMED' } } })
  })
}
