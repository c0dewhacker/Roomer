import type { FastifyInstance } from 'fastify'
import { prisma } from '../lib/prisma.js'
import { createQueueEntrySchema, GlobalRole, NotificationType } from '@roomer/shared'
import { requireAuth } from '../middleware/requireAuth.js'
import { enqueueNotification } from '../lib/queue.js'
import { dispatchWebhook } from '../lib/webhook.js'
import {
  assertBookable,
  assertUnderBookingQuota,
  hasConfirmedOverlap,
  checkZoneGroupOverlap,
  lockAssetForBooking,
  lockAssetForQueue,
  lockUserForBookingQuota,
  isOverlapConstraintViolation,
} from '../lib/booking.js'
import { z } from 'zod'

class QuotaExceededError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message)
    this.name = 'QuotaExceededError'
  }
}

class ZoneGroupConflictError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message)
    this.name = 'ZoneGroupConflictError'
  }
}

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

    // Same bookability gate as a direct booking — you may not queue for an asset
    // you would not be permitted to book (restricted/assigned/group access).
    const gate = await assertBookable(prisma, request.user, assetId, wantedStartsAt, wantedEndsAt)
    if (!gate.ok) {
      return reply.status(gate.status).send({ error: { message: gate.message, code: gate.code } })
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
      await lockAssetForQueue(tx, assetId)

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

    dispatchWebhook('queue.joined', { id: entry.id, userId: entry.userId, assetId: entry.assetId, position: entry.position }).catch(() => {})

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

    dispatchWebhook('queue.cancelled', { id: entry.id, userId: entry.userId, assetId: entry.assetId }).catch(() => {})

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
      include: { asset: true, user: { select: { id: true, globalRole: true } } },
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

    // Re-validate bookability at claim time — the allow list / assignment may have
    // changed since the user joined the queue.
    const gate = await assertBookable(prisma, entry.user, entry.assetId, entry.wantedStartsAt, entry.wantedEndsAt)
    if (!gate.ok) {
      return reply.status(gate.status).send({ error: { message: gate.message, code: gate.code } })
    }

    const quota = await assertUnderBookingQuota(prisma, entry.userId, entry.user.globalRole === GlobalRole.SUPER_ADMIN)
    if (!quota.ok) {
      return reply.status(quota.status).send({ error: { message: quota.message, code: quota.code } })
    }

    let result: Awaited<ReturnType<typeof prisma.booking.create>> | null
    let claimLost = false
    try {
      result = await prisma.$transaction(async (tx) => {
        await lockAssetForBooking(tx, entry.assetId)

        // Overlap check must stay the first possible bail-out: everything
        // below it writes, and returning null from an interactive transaction
        // does NOT roll back writes already made in this callback (only a
        // throw does) — so nothing may be written before this point.
        if (await hasConfirmedOverlap(tx, entry.assetId, entry.wantedStartsAt, entry.wantedEndsAt)) return null

        // The pre-transaction PROMOTED/deadline checks above are TOCTOU-prone:
        // the claim-expiry sweep (a separate cron, its own transaction, a
        // different advisory lock class since it doesn't create a booking)
        // can expire this exact entry and promote someone else in the window
        // between that check and this write. An unconditional update here
        // would claim it anyway — this row only flips if it's still actually
        // claimable at the moment we hold the lock, and nothing else has been
        // written yet if it isn't.
        const claimed = await tx.queueEntry.updateMany({
          where: { id: entry.id, status: 'PROMOTED', claimDeadline: { gt: new Date() } },
          data: { status: 'CLAIMED', claimToken: null },
        })
        if (claimed.count === 0) {
          claimLost = true
          return null
        }

        // The quota check above ran before this transaction, against a
        // different lock domain (per-asset, not per-user) — two concurrent
        // claims/bookings from the same user on different assets could both
        // pass it before either commits. Re-check under a per-user lock, now
        // that the queue entry write above means throwing (not returning
        // null) is required to roll it back on failure.
        await lockUserForBookingQuota(tx, entry.userId)
        const quotaRecheck = await assertUnderBookingQuota(tx, entry.userId, entry.user.globalRole === GlobalRole.SUPER_ADMIN)
        if (!quotaRecheck.ok) {
          throw new QuotaExceededError(quotaRecheck.code, quotaRecheck.message)
        }

        // Same rule direct booking (POST /bookings) and rescheduling enforce —
        // claiming a promoted queue slot shouldn't let a user end up with two
        // overlapping bookings across zones meant to be mutually exclusive for
        // them. Checked here, under the per-user lock just acquired above, for
        // the same lock-domain reason as the quota recheck.
        if (await checkZoneGroupOverlap(tx, entry.userId, entry.assetId, entry.wantedStartsAt, entry.wantedEndsAt)) {
          throw new ZoneGroupConflictError('ZONE_GROUP_CONFLICT', 'You already have a booking in the same zone group for this time')
        }

        return tx.booking.create({
          data: {
            userId: entry.userId,
            assetId: entry.assetId,
            startsAt: entry.wantedStartsAt,
            endsAt: entry.wantedEndsAt,
            status: 'CONFIRMED',
          },
        })
      })
    } catch (err) {
      if (isOverlapConstraintViolation(err)) result = null
      else if (err instanceof QuotaExceededError || err instanceof ZoneGroupConflictError) {
        return reply.status(409).send({ error: { message: err.message, code: err.code } })
      } else throw err
    }

    if (!result) {
      if (claimLost) {
        return reply.status(409).send({ error: { message: 'Claim deadline has passed', code: 'TOKEN_EXPIRED' } })
      }
      return reply.status(409).send({
        error: { message: 'Asset is no longer available for this period', code: 'ASSET_CONFLICT' },
      })
    }

    await enqueueNotification({
      type: NotificationType.BOOKING_CONFIRMED,
      userId: entry.userId,
      bookingId: result.id,
    })

    dispatchWebhook('queue.claimed', { id: entry.id, userId: entry.userId, assetId: entry.assetId, bookingId: result.id }).catch(() => {})

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

    // Re-validate bookability at claim time — the allow list / assignment may have
    // changed since the user joined the queue.
    const gate = await assertBookable(prisma, request.user, entry.assetId, entry.wantedStartsAt, entry.wantedEndsAt)
    if (!gate.ok) {
      return reply.status(gate.status).send({ error: { message: gate.message, code: gate.code } })
    }

    const quota = await assertUnderBookingQuota(prisma, request.user.id, request.user.globalRole === GlobalRole.SUPER_ADMIN)
    if (!quota.ok) {
      return reply.status(quota.status).send({ error: { message: quota.message, code: quota.code } })
    }

    // Serialize on the asset ID, then check availability and create booking atomically
    let booking: Awaited<ReturnType<typeof prisma.booking.create>> | null
    let claimLost = false
    try {
      booking = await prisma.$transaction(async (tx) => {
        await lockAssetForBooking(tx, entry.assetId)

        // Overlap check must stay the first possible bail-out: everything
        // below it writes, and returning null from an interactive transaction
        // does NOT roll back writes already made in this callback (only a
        // throw does) — so nothing may be written before this point.
        if (await hasConfirmedOverlap(tx, entry.assetId, entry.wantedStartsAt, entry.wantedEndsAt)) return null

        // The pre-transaction PROMOTED/deadline checks above are TOCTOU-prone:
        // the claim-expiry sweep (a separate cron, its own transaction, a
        // different advisory lock class since it doesn't create a booking)
        // can expire this exact entry and promote someone else in the window
        // between that check and this write. An unconditional update here
        // would claim it anyway — this row only flips if it's still actually
        // claimable at the moment we hold the lock, and nothing else has been
        // written yet if it isn't.
        const claimed = await tx.queueEntry.updateMany({
          where: { id, status: 'PROMOTED', claimDeadline: { gt: new Date() } },
          data: { status: 'CLAIMED', claimToken: null },
        })
        if (claimed.count === 0) {
          claimLost = true
          return null
        }

        // The quota check above ran before this transaction, against a
        // different lock domain (per-asset, not per-user) — two concurrent
        // claims/bookings from the same user on different assets could both
        // pass it before either commits. Re-check under a per-user lock, now
        // that the queue entry write above means throwing (not returning
        // null) is required to roll it back on failure.
        await lockUserForBookingQuota(tx, request.user.id)
        const quotaRecheck = await assertUnderBookingQuota(tx, request.user.id, request.user.globalRole === GlobalRole.SUPER_ADMIN)
        if (!quotaRecheck.ok) {
          throw new QuotaExceededError(quotaRecheck.code, quotaRecheck.message)
        }

        // Same rule direct booking (POST /bookings) and rescheduling enforce —
        // see the matching comment in /claim-by-token above.
        if (await checkZoneGroupOverlap(tx, request.user.id, entry.assetId, entry.wantedStartsAt, entry.wantedEndsAt)) {
          throw new ZoneGroupConflictError('ZONE_GROUP_CONFLICT', 'You already have a booking in the same zone group for this time')
        }

        return tx.booking.create({
          data: {
            userId: request.user.id,
            assetId: entry.assetId,
            startsAt: entry.wantedStartsAt,
            endsAt: entry.wantedEndsAt,
            status: 'CONFIRMED',
          },
        })
      })
    } catch (err) {
      if (isOverlapConstraintViolation(err)) booking = null
      else if (err instanceof QuotaExceededError || err instanceof ZoneGroupConflictError) {
        return reply.status(409).send({ error: { message: err.message, code: err.code } })
      } else throw err
    }

    if (!booking) {
      if (claimLost) {
        return reply.status(409).send({ error: { message: 'Claim deadline has passed', code: 'CLAIM_EXPIRED' } })
      }
      return reply.status(409).send({
        error: { message: 'Asset is no longer available for this period', code: 'ASSET_CONFLICT' },
      })
    }

    await enqueueNotification({
      type: NotificationType.BOOKING_CONFIRMED,
      userId: request.user.id,
      bookingId: booking.id,
    })

    dispatchWebhook('queue.claimed', { id: entry.id, userId: entry.userId, assetId: entry.assetId, bookingId: booking.id }).catch(() => {})

    return reply.status(201).send({ data: { booking, queueEntry: { id, status: 'CLAIMED' } } })
  })
}
