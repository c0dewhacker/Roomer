import type { FastifyInstance } from 'fastify'
import { BookingConflictError } from '../../lib/booking-update.js'
import { prisma } from '../../lib/prisma.js'
import { GlobalRole, NotificationType } from '@roomer/shared'
import { requireAuth } from '../../middleware/requireAuth.js'
import { enqueueNotification } from '../../lib/queue.js'
import { dispatchWebhook } from '../../lib/webhook.js'
import { assertBookable, assertUnderBookingQuota, checkZoneGroupOverlap, isNotAlreadyElapsed, lockAssetForBooking, lockUserForBookingQuota } from '../../lib/booking.js'
import { recordAuditLog } from '../../lib/audit.js'
import { z } from 'zod'

export async function bookingTransfersRoutes(fastify: FastifyInstance): Promise<void> {
  // ─── Booking transfer ──────────────────────────────────────────────────────
  // Hand a CONFIRMED booking to a colleague. The recipient must accept before
  // booking.userId actually changes (see #83) — a unilateral reassignment
  // would let someone dump an unwanted booking on a colleague with no say.

  const transferRequestSchema = z.object({ toUserId: z.string().min(1) })

  // POST /bookings/:id/transfer — offer a booking to a colleague
  fastify.post('/:id/transfer', { preHandler: [requireAuth] }, async (request, reply) => {
    const { id } = request.params as { id: string }
    const result = transferRequestSchema.safeParse(request.body)
    if (!result.success) {
      return reply.status(400).send({ error: { message: 'Validation failed', code: 'VALIDATION_ERROR', details: result.error.flatten() } })
    }
    const { toUserId } = result.data

    const booking = await prisma.booking.findUnique({ where: { id } })
    if (!booking) return reply.status(404).send({ error: { message: 'Booking not found', code: 'NOT_FOUND' } })
    if (booking.userId !== request.user.id) {
      return reply.status(403).send({ error: { message: 'You can only transfer your own bookings', code: 'FORBIDDEN' } })
    }
    if (booking.status !== 'CONFIRMED') {
      return reply.status(409).send({ error: { message: 'Booking is not active', code: 'BOOKING_NOT_ACTIVE' } })
    }
    if (!isNotAlreadyElapsed(booking.endsAt)) {
      return reply.status(400).send({ error: { message: 'This booking has already passed', code: 'ALREADY_ELAPSED' } })
    }
    if (toUserId === request.user.id) {
      return reply.status(400).send({ error: { message: 'You cannot transfer a booking to yourself', code: 'VALIDATION_ERROR' } })
    }
    const toUser = await prisma.user.findUnique({ where: { id: toUserId }, select: { id: true, accountStatus: true } })
    if (!toUser || toUser.accountStatus !== 'ACTIVE') {
      return reply.status(404).send({ error: { message: 'Recipient not found', code: 'NOT_FOUND' } })
    }

    // A booking can only have one live offer against it at a time — check
    // both tables, not just this one. Without this, the same booking could
    // have a pending transfer AND a pending swap simultaneously, and
    // whichever gets accepted second would silently undo the first (see
    // the ownership recheck in both accept handlers for the backstop).
    const [existingTransfer, existingSwap] = await Promise.all([
      prisma.bookingTransfer.findFirst({ where: { bookingId: id, status: 'PENDING' } }),
      prisma.bookingSwap.findFirst({ where: { status: 'PENDING', OR: [{ bookingAId: id }, { bookingBId: id }] } }),
    ])
    if (existingTransfer || existingSwap) {
      return reply.status(409).send({ error: { message: 'This booking already has a pending transfer or swap request', code: 'TRANSFER_ALREADY_PENDING' } })
    }

    const org = await prisma.organisation.findFirst({ select: { queueClaimWindowHours: true } })
    const windowHours = org?.queueClaimWindowHours ?? 4
    const expiresAt = new Date(Date.now() + windowHours * 3600 * 1000)

    const transfer = await prisma.bookingTransfer.create({
      data: { bookingId: id, fromUserId: request.user.id, toUserId, expiresAt },
    })

    await enqueueNotification({
      type: NotificationType.BOOKING_TRANSFER_REQUESTED,
      userId: toUserId,
      transferId: transfer.id,
    })
    dispatchWebhook('booking.transfer_requested', { id: transfer.id, bookingId: id, fromUserId: request.user.id, toUserId }).catch(() => {})
    await recordAuditLog(prisma, {
      actorId: request.user.id,
      action: 'booking_transfer.requested',
      resourceType: 'BookingTransfer',
      resourceId: transfer.id,
      after: { bookingId: id, fromUserId: request.user.id, toUserId },
      ipAddress: request.ip,
    }, request.log)

    return reply.status(201).send({ data: transfer })
  })

  // GET /bookings/transfers — transfers sent and received (pending only for received) by the current user
  fastify.get('/transfers', { preHandler: [requireAuth] }, async (request, reply) => {
    const bookingSelect = {
      select: {
        id: true, startsAt: true, endsAt: true,
        asset: { select: { name: true, floor: { select: { building: { select: { timezone: true } } } } } },
      },
    } as const
    const [sent, received, org] = await Promise.all([
      prisma.bookingTransfer.findMany({
        where: { fromUserId: request.user.id },
        orderBy: { createdAt: 'desc' },
        include: { booking: bookingSelect, toUser: { select: { id: true, displayName: true, email: true } } },
      }),
      prisma.bookingTransfer.findMany({
        where: { toUserId: request.user.id, status: 'PENDING' },
        orderBy: { createdAt: 'desc' },
        include: { booking: bookingSelect, fromUser: { select: { id: true, displayName: true, email: true } } },
      }),
      prisma.organisation.findFirst({ select: { defaultTimezone: true } }),
    ])
    // Same resolvedTimezone convention as GET /bookings and every other
    // booking-list endpoint in this file (#72) — without it, both the
    // proposer's and recipient's dialogs/lists rendered the booking's time in
    // each viewer's own browser timezone rather than the booking's building.
    const withTz = <T extends { booking: { asset: { floor: { building: { timezone: string | null } } | null } | null } }>(rows: T[]) =>
      rows.map((r) => ({ ...r, booking: { ...r.booking, resolvedTimezone: r.booking.asset?.floor?.building?.timezone ?? org?.defaultTimezone ?? 'UTC' } }))
    return reply.status(200).send({ data: { sent: withTz(sent), received: withTz(received) } })
  })

  // POST /bookings/transfers/:id/accept
  fastify.post('/transfers/:id/accept', { preHandler: [requireAuth] }, async (request, reply) => {
    const { id } = request.params as { id: string }
    const transfer = await prisma.bookingTransfer.findUnique({ where: { id }, include: { booking: true } })
    if (!transfer) return reply.status(404).send({ error: { message: 'Transfer not found', code: 'NOT_FOUND' } })
    if (transfer.toUserId !== request.user.id) {
      return reply.status(403).send({ error: { message: 'Forbidden', code: 'FORBIDDEN' } })
    }
    if (transfer.status !== 'PENDING') {
      return reply.status(409).send({ error: { message: 'This transfer request is no longer pending', code: 'NOT_PENDING' } })
    }
    if (transfer.expiresAt < new Date()) {
      return reply.status(409).send({ error: { message: 'This transfer request has expired', code: 'TRANSFER_EXPIRED' } })
    }
    if (transfer.booking.status !== 'CONFIRMED') {
      return reply.status(409).send({ error: { message: 'This booking is no longer active', code: 'BOOKING_NOT_ACTIVE' } })
    }
    if (!isNotAlreadyElapsed(transfer.booking.endsAt)) {
      return reply.status(400).send({ error: { message: 'This booking has already passed', code: 'ALREADY_ELAPSED' } })
    }

    // Re-validate the recipient can actually book this asset — the allow
    // list, bookingStatus, or the recipient's group access may have changed
    // since the transfer was offered (same reasoning every other
    // accept-a-pending-thing path in this codebase re-checks: queue claims,
    // make-available auto-confirm).
    const gate = await assertBookable(prisma, request.user, transfer.booking.assetId, transfer.booking.startsAt, transfer.booking.endsAt)
    if (!gate.ok) {
      return reply.status(gate.status).send({ error: { message: gate.message, code: gate.code } })
    }
    const quota = await assertUnderBookingQuota(prisma, request.user.id, request.user.globalRole === GlobalRole.SUPER_ADMIN)
    if (!quota.ok) {
      return reply.status(quota.status).send({ error: { message: quota.message, code: quota.code } })
    }
    // No isWithinAdvanceBookingWindow re-check here, unlike every path that
    // sets a new startsAt (create, reschedule, queue claims) — a transfer
    // doesn't move the booking's time, so the org's maxAdvanceBookingDays cap
    // was already satisfied whenever the booking was originally made.

    try {
      await prisma.$transaction(async (tx) => {
        await lockAssetForBooking(tx, transfer.booking.assetId)
        await lockUserForBookingQuota(tx, request.user.id)

        // Re-fetch under the lock before doing anything else — the booking
        // may have been reassigned by a different pending offer (e.g. this
        // same booking also had a swap proposed and accepted concurrently)
        // or rescheduled to a new time since the checks above ran. Every
        // check below must use `fresh`, not the outer `transfer`/`booking`
        // snapshot, or it validates a state that's no longer live.
        const fresh = await tx.bookingTransfer.findUnique({ where: { id }, include: { booking: true } })
        if (!fresh || fresh.status !== 'PENDING') {
          throw new BookingConflictError('NOT_PENDING', 'This transfer request is no longer pending')
        }
        if (fresh.booking.status !== 'CONFIRMED') {
          throw new BookingConflictError('BOOKING_NOT_ACTIVE', 'This booking is no longer active')
        }
        if (fresh.booking.userId !== fresh.fromUserId) {
          // Ownership already moved (e.g. a competing swap on the same
          // booking was accepted first) — this offer is stale even though
          // its own status/expiry never changed.
          throw new BookingConflictError('BOOKING_NOT_ACTIVE', 'This booking is no longer available for transfer')
        }

        const quotaRecheck = await assertUnderBookingQuota(tx, request.user.id, request.user.globalRole === GlobalRole.SUPER_ADMIN)
        if (!quotaRecheck.ok) {
          throw new BookingConflictError(quotaRecheck.code, quotaRecheck.message)
        }
        if (await checkZoneGroupOverlap(tx, request.user.id, fresh.booking.assetId, fresh.booking.startsAt, fresh.booking.endsAt)) {
          throw new BookingConflictError('ZONE_GROUP_CONFLICT', 'You already have a booking in the same zone group for this time')
        }

        // Ownership changes, the time slot doesn't — bump icsSequence so a
        // re-sent REQUEST (to the new owner) is recognised as superseding
        // whatever the original owner's calendar app still has.
        //
        // Guarded on status: 'CONFIRMED', not a bare update-by-id — the
        // fresh.booking.status check above only reads the state as of a
        // moment ago; DELETE /bookings/:id (direct cancellation) takes no
        // lock on this asset at all, so it isn't coordinated by
        // lockAssetForBooking above and can still commit a cancellation in
        // the gap between that read and this write (the quota/zone-group
        // checks in between are both real await points). Without this, a
        // booking the owner just cancelled could still get its userId
        // reassigned to the transfer recipient, leaving a CANCELLED booking
        // that appears to belong to someone who never actually got a desk.
        const bookingClaimed = await tx.booking.updateMany({
          where: { id: fresh.bookingId, status: 'CONFIRMED' },
          data: { userId: request.user.id, icsSequence: { increment: 1 } },
        })
        if (bookingClaimed.count === 0) {
          throw new BookingConflictError('BOOKING_NOT_ACTIVE', 'This booking is no longer active')
        }
        // Guarded on status: 'PENDING' here too, not just the `fresh` read
        // above — decline/withdraw take no lock of their own, so without
        // this, one of them could still land between that read and this
        // write and get silently clobbered back to ACCEPTED.
        const claimed = await tx.bookingTransfer.updateMany({
          where: { id, status: 'PENDING' },
          data: { status: 'ACCEPTED', respondedAt: new Date() },
        })
        if (claimed.count === 0) {
          throw new BookingConflictError('NOT_PENDING', 'This transfer request is no longer pending')
        }
      })
    } catch (err) {
      if (err instanceof BookingConflictError) {
        return reply.status(409).send({ error: { message: err.message, code: err.code } })
      }
      throw err
    }

    await enqueueNotification({ type: NotificationType.BOOKING_TRANSFER_ACCEPTED, userId: transfer.fromUserId, transferId: transfer.id })
    await enqueueNotification({ type: NotificationType.BOOKING_CONFIRMED, userId: request.user.id, bookingId: transfer.bookingId })
    dispatchWebhook('booking.transfer_accepted', { id: transfer.id, bookingId: transfer.bookingId, fromUserId: transfer.fromUserId, toUserId: transfer.toUserId }).catch(() => {})
    await recordAuditLog(prisma, {
      actorId: request.user.id,
      action: 'booking_transfer.accepted',
      resourceType: 'Booking',
      resourceId: transfer.bookingId,
      before: { userId: transfer.fromUserId },
      after: { userId: request.user.id },
      ipAddress: request.ip,
    }, request.log)

    return reply.status(200).send({ data: { ok: true } })
  })

  // POST /bookings/transfers/:id/decline
  fastify.post('/transfers/:id/decline', { preHandler: [requireAuth] }, async (request, reply) => {
    const { id } = request.params as { id: string }
    const transfer = await prisma.bookingTransfer.findUnique({ where: { id } })
    if (!transfer) return reply.status(404).send({ error: { message: 'Transfer not found', code: 'NOT_FOUND' } })
    if (transfer.toUserId !== request.user.id) {
      return reply.status(403).send({ error: { message: 'Forbidden', code: 'FORBIDDEN' } })
    }
    if (transfer.status !== 'PENDING') {
      return reply.status(409).send({ error: { message: 'This transfer request is no longer pending', code: 'NOT_PENDING' } })
    }
    // Guarded on the write itself (status: 'PENDING'), not just the check
    // above — without this, a decline racing the recipient's own accept (or
    // the requester's withdraw) could land after accept already committed
    // ACCEPTED + reassigned the booking, silently overwriting it back to
    // DECLINED with no error to either side, while both outcomes' webhooks/
    // notifications fire regardless.
    const declined = await prisma.bookingTransfer.updateMany({ where: { id, status: 'PENDING' }, data: { status: 'DECLINED', respondedAt: new Date() } })
    if (declined.count === 0) {
      return reply.status(409).send({ error: { message: 'This transfer request is no longer pending', code: 'NOT_PENDING' } })
    }
    await enqueueNotification({ type: NotificationType.BOOKING_TRANSFER_DECLINED, userId: transfer.fromUserId, transferId: transfer.id })
    dispatchWebhook('booking.transfer_declined', { id: transfer.id, bookingId: transfer.bookingId, fromUserId: transfer.fromUserId, toUserId: transfer.toUserId }).catch(() => {})
    await recordAuditLog(prisma, {
      actorId: request.user.id,
      action: 'booking_transfer.declined',
      resourceType: 'BookingTransfer',
      resourceId: id,
      before: { status: 'PENDING' },
      after: { status: 'DECLINED' },
      ipAddress: request.ip,
    }, request.log)
    return reply.status(200).send({ data: { ok: true } })
  })

  // DELETE /bookings/transfers/:id — requester withdraws a still-pending offer
  fastify.delete('/transfers/:id', { preHandler: [requireAuth] }, async (request, reply) => {
    const { id } = request.params as { id: string }
    const transfer = await prisma.bookingTransfer.findUnique({ where: { id } })
    if (!transfer) return reply.status(404).send({ error: { message: 'Transfer not found', code: 'NOT_FOUND' } })
    if (transfer.fromUserId !== request.user.id) {
      return reply.status(403).send({ error: { message: 'Forbidden', code: 'FORBIDDEN' } })
    }
    if (transfer.status !== 'PENDING') {
      return reply.status(409).send({ error: { message: 'This transfer request is no longer pending', code: 'NOT_PENDING' } })
    }
    // Guarded on the write itself — same reasoning as decline above: without
    // this, a withdraw racing the recipient's accept could land after accept
    // already committed, silently overwriting the record back to CANCELLED
    // even though the booking really did change hands.
    const cancelled = await prisma.bookingTransfer.updateMany({ where: { id, status: 'PENDING' }, data: { status: 'CANCELLED', respondedAt: new Date() } })
    if (cancelled.count === 0) {
      return reply.status(409).send({ error: { message: 'This transfer request is no longer pending', code: 'NOT_PENDING' } })
    }
    await recordAuditLog(prisma, {
      actorId: request.user.id,
      action: 'booking_transfer.cancelled',
      resourceType: 'BookingTransfer',
      resourceId: id,
      before: { status: 'PENDING' },
      after: { status: 'CANCELLED' },
      ipAddress: request.ip,
    }, request.log)
    return reply.status(200).send({ data: { ok: true } })
  })


}
