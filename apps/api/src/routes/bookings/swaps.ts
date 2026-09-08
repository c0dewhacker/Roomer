import type { FastifyInstance } from 'fastify'
import { BookingConflictError } from '../../lib/booking-update.js'
import { prisma } from '../../lib/prisma.js'
import { GlobalRole, NotificationType } from '@roomer/shared'
import { requireAuth } from '../../middleware/requireAuth.js'
import { enqueueNotification } from '../../lib/queue.js'
import { dispatchWebhook } from '../../lib/webhook.js'
import { checkGroupAccess } from '../groups.js'
import { assertBookable, checkZoneGroupOverlap, isNotAlreadyElapsed, lockAssetForBooking, lockUserForBookingQuota } from '../../lib/booking.js'
import { recordAuditLog } from '../../lib/audit.js'
import { z } from 'zod'

export async function bookingSwapsRoutes(fastify: FastifyInstance): Promise<void> {
  // ─── Booking swap ───────────────────────────────────────────────────────────
  // Two users trade bookings — same start/end time (see #83: mismatched-time
  // swaps are out of scope for now), different assets. Requires mutual
  // consent, same shape as transfer.

  const swapRequestSchema = z.object({ withBookingId: z.string().min(1) })

  // GET /bookings/:id/swap-candidate?userId= — does this colleague have a
  // CONFIRMED booking at exactly the same time as booking :id? Powers the
  // swap-request UI: a user can't be expected to already know another
  // booking's id, so given "swap booking :id with this colleague", this
  // looks up which (if any) of their bookings actually qualifies. Narrow by
  // design — only returns a match for the one exact time window being
  // proposed, not the colleague's other bookings.
  fastify.get('/:id/swap-candidate', { preHandler: [requireAuth] }, async (request, reply) => {
    const { id } = request.params as { id: string }
    const query = z.object({ userId: z.string().min(1) }).safeParse(request.query)
    if (!query.success) {
      return reply.status(400).send({ error: { message: 'userId query param required', code: 'VALIDATION_ERROR' } })
    }
    const booking = await prisma.booking.findUnique({ where: { id } })
    if (!booking) return reply.status(404).send({ error: { message: 'Booking not found', code: 'NOT_FOUND' } })
    if (booking.userId !== request.user.id) {
      return reply.status(403).send({ error: { message: 'Forbidden', code: 'FORBIDDEN' } })
    }
    // Scoped to visibleInColleagueSearch — the caller fully controls
    // startsAt/endsAt (by making or already holding a booking at any chosen
    // time), so without this filter userId is an unrestricted "does user X
    // have a confirmed booking at time T, and on which desk" oracle for
    // ANY user in the organisation, independent of any real intent to
    // propose a swap. This is the same privacy flag /users/search already
    // gates the colleague picker on, which this endpoint is meant to be
    // used after — someone who's opted out of colleague search shouldn't
    // be locatable through this side door instead.
    const candidate = await prisma.booking.findFirst({
      where: {
        userId: query.data.userId,
        status: 'CONFIRMED',
        startsAt: booking.startsAt,
        endsAt: booking.endsAt,
        assetId: { not: booking.assetId },
        user: { visibleInColleagueSearch: true },
      },
      select: {
        id: true,
        startsAt: true,
        endsAt: true,
        asset: { select: { id: true, name: true, floor: { select: { id: true, buildingId: true } } } },
      },
    })

    // Same reasoning as the visibleInColleagueSearch filter above: without
    // this, the endpoint would additionally leak which restricted-floor desk
    // a colleague is sitting on to a caller who has no access to that floor
    // at all — returning null (indistinguishable from "no match") rather than
    // 403 so its existence isn't disclosed either.
    if (candidate?.asset.floor && request.user.globalRole !== GlobalRole.SUPER_ADMIN) {
      const allowed = await checkGroupAccess(request.user.id, candidate.asset.floor.buildingId, candidate.asset.floor.id)
      if (!allowed) {
        return reply.status(200).send({ data: null })
      }
    }

    return reply.status(200).send({
      data: candidate && { id: candidate.id, startsAt: candidate.startsAt, endsAt: candidate.endsAt, asset: { id: candidate.asset.id, name: candidate.asset.name } },
    })
  })

  // POST /bookings/:id/swap-request
  fastify.post('/:id/swap-request', { preHandler: [requireAuth] }, async (request, reply) => {
    const { id } = request.params as { id: string }
    const result = swapRequestSchema.safeParse(request.body)
    if (!result.success) {
      return reply.status(400).send({ error: { message: 'Validation failed', code: 'VALIDATION_ERROR', details: result.error.flatten() } })
    }
    const { withBookingId } = result.data
    if (withBookingId === id) {
      return reply.status(400).send({ error: { message: 'Cannot swap a booking with itself', code: 'VALIDATION_ERROR' } })
    }

    const [bookingA, bookingB] = await Promise.all([
      prisma.booking.findUnique({ where: { id } }),
      prisma.booking.findUnique({ where: { id: withBookingId } }),
    ])
    if (!bookingA) return reply.status(404).send({ error: { message: 'Booking not found', code: 'NOT_FOUND' } })
    if (!bookingB) return reply.status(404).send({ error: { message: 'The other booking was not found', code: 'NOT_FOUND' } })
    if (bookingA.userId !== request.user.id) {
      return reply.status(403).send({ error: { message: 'You can only propose a swap for your own booking', code: 'FORBIDDEN' } })
    }
    if (bookingB.userId === request.user.id) {
      return reply.status(400).send({ error: { message: 'You cannot swap with your own booking', code: 'VALIDATION_ERROR' } })
    }
    if (bookingA.status !== 'CONFIRMED' || bookingB.status !== 'CONFIRMED') {
      return reply.status(409).send({ error: { message: 'Both bookings must be active', code: 'BOOKING_NOT_ACTIVE' } })
    }
    if (!isNotAlreadyElapsed(bookingA.endsAt) || !isNotAlreadyElapsed(bookingB.endsAt)) {
      return reply.status(400).send({ error: { message: 'Both bookings must be in the future', code: 'ALREADY_ELAPSED' } })
    }
    if (bookingA.assetId === bookingB.assetId) {
      return reply.status(400).send({ error: { message: 'These bookings are already for the same desk', code: 'VALIDATION_ERROR' } })
    }
    if (bookingA.startsAt.getTime() !== bookingB.startsAt.getTime() || bookingA.endsAt.getTime() !== bookingB.endsAt.getTime()) {
      return reply.status(400).send({ error: { message: 'Swaps are only supported for bookings at the same time', code: 'TIME_MISMATCH' } })
    }

    // Same cross-type check as transfer creation — a booking with a pending
    // transfer shouldn't also be offerable in a swap (see the ownership
    // recheck in both accept handlers for the backstop).
    const [existingSwap, existingTransfer] = await Promise.all([
      prisma.bookingSwap.findFirst({
        where: {
          status: 'PENDING',
          OR: [
            { bookingAId: { in: [id, withBookingId] } },
            { bookingBId: { in: [id, withBookingId] } },
          ],
        },
      }),
      prisma.bookingTransfer.findFirst({ where: { bookingId: { in: [id, withBookingId] }, status: 'PENDING' } }),
    ])
    if (existingSwap || existingTransfer) {
      return reply.status(409).send({ error: { message: 'One of these bookings already has a pending transfer or swap request', code: 'SWAP_ALREADY_PENDING' } })
    }

    const org = await prisma.organisation.findFirst({ select: { queueClaimWindowHours: true } })
    const windowHours = org?.queueClaimWindowHours ?? 4
    const expiresAt = new Date(Date.now() + windowHours * 3600 * 1000)

    const swap = await prisma.bookingSwap.create({
      data: {
        bookingAId: id,
        bookingBId: withBookingId,
        initiatorUserId: request.user.id,
        recipientUserId: bookingB.userId,
        expiresAt,
      },
    })

    await enqueueNotification({ type: NotificationType.BOOKING_SWAP_REQUESTED, userId: bookingB.userId, swapId: swap.id })
    dispatchWebhook('booking.swap_requested', { id: swap.id, bookingAId: id, bookingBId: withBookingId, initiatorUserId: request.user.id, recipientUserId: bookingB.userId }).catch(() => {})
    await recordAuditLog(prisma, {
      actorId: request.user.id,
      action: 'booking_swap.requested',
      resourceType: 'BookingSwap',
      resourceId: swap.id,
      after: { bookingAId: id, bookingBId: withBookingId, initiatorUserId: request.user.id, recipientUserId: bookingB.userId },
      ipAddress: request.ip,
    }, request.log)

    return reply.status(201).send({ data: swap })
  })

  // GET /bookings/swaps
  fastify.get('/swaps', { preHandler: [requireAuth] }, async (request, reply) => {
    const bookingSelect = {
      select: {
        id: true, startsAt: true, endsAt: true,
        asset: { select: { name: true, floor: { select: { building: { select: { timezone: true } } } } } },
      },
    } as const
    const [sent, received, org] = await Promise.all([
      prisma.bookingSwap.findMany({
        where: { initiatorUserId: request.user.id },
        orderBy: { createdAt: 'desc' },
        include: { bookingA: bookingSelect, bookingB: bookingSelect, recipient: { select: { id: true, displayName: true, email: true } } },
      }),
      prisma.bookingSwap.findMany({
        where: { recipientUserId: request.user.id, status: 'PENDING' },
        orderBy: { createdAt: 'desc' },
        include: { bookingA: bookingSelect, bookingB: bookingSelect, initiator: { select: { id: true, displayName: true, email: true } } },
      }),
      prisma.organisation.findFirst({ select: { defaultTimezone: true } }),
    ])
    // Same resolvedTimezone convention as /transfers above — bookingA and
    // bookingB can be in different buildings entirely, so each gets its own
    // resolved value rather than assuming one applies to both sides.
    type SwapBooking = { asset: { floor: { building: { timezone: string | null } } | null } | null }
    const tz = (b: SwapBooking) => b.asset?.floor?.building?.timezone ?? org?.defaultTimezone ?? 'UTC'
    const withTz = <T extends { bookingA: SwapBooking; bookingB: SwapBooking }>(rows: T[]) =>
      rows.map((r) => ({ ...r, bookingA: { ...r.bookingA, resolvedTimezone: tz(r.bookingA) }, bookingB: { ...r.bookingB, resolvedTimezone: tz(r.bookingB) } }))
    return reply.status(200).send({ data: { sent: withTz(sent), received: withTz(received) } })
  })

  // POST /bookings/swaps/:id/accept
  fastify.post('/swaps/:id/accept', { preHandler: [requireAuth] }, async (request, reply) => {
    const { id } = request.params as { id: string }
    const swap = await prisma.bookingSwap.findUnique({ where: { id }, include: { bookingA: true, bookingB: true } })
    if (!swap) return reply.status(404).send({ error: { message: 'Swap not found', code: 'NOT_FOUND' } })
    if (swap.recipientUserId !== request.user.id) {
      return reply.status(403).send({ error: { message: 'Forbidden', code: 'FORBIDDEN' } })
    }
    if (swap.status !== 'PENDING') {
      return reply.status(409).send({ error: { message: 'This swap request is no longer pending', code: 'NOT_PENDING' } })
    }
    if (swap.expiresAt < new Date()) {
      return reply.status(409).send({ error: { message: 'This swap request has expired', code: 'SWAP_EXPIRED' } })
    }
    if (swap.bookingA.status !== 'CONFIRMED' || swap.bookingB.status !== 'CONFIRMED') {
      return reply.status(409).send({ error: { message: 'Both bookings must still be active', code: 'BOOKING_NOT_ACTIVE' } })
    }
    if (!isNotAlreadyElapsed(swap.bookingA.endsAt) || !isNotAlreadyElapsed(swap.bookingB.endsAt)) {
      return reply.status(400).send({ error: { message: 'Both bookings must be in the future', code: 'ALREADY_ELAPSED' } })
    }

    // Re-validate both directions — the initiator ends up on bookingB's
    // asset, the recipient (this caller) ends up on bookingA's asset. Same
    // "access may have changed since the request was made" reasoning as
    // transfer accept.
    const initiatorUser = await prisma.user.findUnique({ where: { id: swap.initiatorUserId }, select: { id: true, globalRole: true } })
    if (!initiatorUser) return reply.status(404).send({ error: { message: 'Initiator no longer exists', code: 'NOT_FOUND' } })

    const [gateForInitiatorOnB, gateForRecipientOnA] = await Promise.all([
      assertBookable(prisma, initiatorUser, swap.bookingB.assetId, swap.bookingB.startsAt, swap.bookingB.endsAt),
      assertBookable(prisma, request.user, swap.bookingA.assetId, swap.bookingA.startsAt, swap.bookingA.endsAt),
    ])
    if (!gateForInitiatorOnB.ok) {
      return reply.status(409).send({ error: { message: `The other desk is no longer available to its new owner: ${gateForInitiatorOnB.message}`, code: gateForInitiatorOnB.code } })
    }
    if (!gateForRecipientOnA.ok) {
      return reply.status(gateForRecipientOnA.status).send({ error: { message: gateForRecipientOnA.message, code: gateForRecipientOnA.code } })
    }
    // No isWithinAdvanceBookingWindow re-check for either side, same
    // reasoning as transfer accept — a swap trades ownership of two existing
    // slots, it doesn't move either booking's time, so both were already
    // within the org's maxAdvanceBookingDays cap when originally made.

    // Lock both assets and both users in a fixed, globally consistent order
    // (sorted ids) — otherwise two concurrent swap-accepts touching an
    // overlapping pair of assets/users could each acquire their first lock
    // and then deadlock waiting on the other's.
    const assetIds = [swap.bookingA.assetId, swap.bookingB.assetId].sort()
    const userIds = [swap.initiatorUserId, swap.recipientUserId].sort()

    try {
      await prisma.$transaction(async (tx) => {
        for (const assetId of assetIds) await lockAssetForBooking(tx, assetId)
        for (const userId of userIds) await lockUserForBookingQuota(tx, userId)

        const fresh = await tx.bookingSwap.findUnique({ where: { id }, include: { bookingA: true, bookingB: true } })
        if (!fresh || fresh.status !== 'PENDING') {
          throw new BookingConflictError('NOT_PENDING', 'This swap request is no longer pending')
        }
        if (fresh.bookingA.status !== 'CONFIRMED' || fresh.bookingB.status !== 'CONFIRMED') {
          throw new BookingConflictError('BOOKING_NOT_ACTIVE', 'Both bookings must still be active')
        }
        if (fresh.bookingA.userId !== fresh.initiatorUserId || fresh.bookingB.userId !== fresh.recipientUserId) {
          // Ownership of one side already moved (e.g. a competing transfer
          // on the same booking was accepted first) — this swap is stale
          // even though its own status/expiry never changed.
          throw new BookingConflictError('BOOKING_NOT_ACTIVE', 'This swap is no longer valid — one of the bookings has changed hands')
        }
        if (fresh.bookingA.startsAt.getTime() !== fresh.bookingB.startsAt.getTime() || fresh.bookingA.endsAt.getTime() !== fresh.bookingB.endsAt.getTime()) {
          // PATCH /bookings/:id now blocks rescheduling a booking with a
          // pending swap, but this is the authoritative backstop — every
          // other invariant this handler re-validates instead of trusting
          // propose-time state gets one, and this is the load-bearing one:
          // without it, one side being rescheduled between propose and
          // accept would silently move the other party onto a slot they
          // never agreed to.
          throw new BookingConflictError('TIME_MISMATCH', 'These bookings no longer share the same time — this swap is no longer valid')
        }

        // Quota doesn't change for either party (each trades one CONFIRMED
        // booking for another, not gaining one), so no quota recheck is
        // needed here — unlike transfer/queue-claim, which do add a new
        // booking to the recipient's count. Excluding each party's own
        // about-to-be-given-up booking from its own zone-group check below
        // avoids it trivially conflicting with itself.
        if (await checkZoneGroupOverlap(tx, fresh.recipientUserId, fresh.bookingA.assetId, fresh.bookingA.startsAt, fresh.bookingA.endsAt, fresh.bookingB.id)) {
          throw new BookingConflictError('ZONE_GROUP_CONFLICT', 'The recipient already has a booking in the same zone group for this time')
        }
        if (await checkZoneGroupOverlap(tx, fresh.initiatorUserId, fresh.bookingB.assetId, fresh.bookingB.startsAt, fresh.bookingB.endsAt, fresh.bookingA.id)) {
          throw new BookingConflictError('ZONE_GROUP_CONFLICT', 'You already have a booking in the same zone group for this time')
        }

        // Guarded on status: 'CONFIRMED', not a bare update-by-id — same
        // reasoning as transfer accept above: DELETE /bookings/:id takes no
        // lock on either asset, so it isn't coordinated by the locks taken
        // at the top of this transaction and could still cancel either side
        // in the gap between the status check above and these writes (the
        // zone-group checks in between are real await points).
        // icsSequence is deliberately left untouched here — unlike the
        // reschedule/transfer paths, nothing about this write itself is
        // re-sent as a REQUEST at a bumped value. The give-up side's
        // BOOKING_CANCELLED job (enqueued below) does its own +1 off
        // whatever value is current, and that's the only bump either
        // booking needs; bumping here too would make that CANCEL land two
        // sequence numbers ahead instead of one, contradicting the
        // "CANCEL always uses sequence+1" invariant documented on the
        // schema field.
        const claimedA = await tx.booking.updateMany({ where: { id: fresh.bookingAId, status: 'CONFIRMED' }, data: { userId: fresh.recipientUserId } })
        if (claimedA.count === 0) {
          throw new BookingConflictError('BOOKING_NOT_ACTIVE', 'Both bookings must still be active')
        }
        const claimedB = await tx.booking.updateMany({ where: { id: fresh.bookingBId, status: 'CONFIRMED' }, data: { userId: fresh.initiatorUserId } })
        if (claimedB.count === 0) {
          throw new BookingConflictError('BOOKING_NOT_ACTIVE', 'Both bookings must still be active')
        }
        // Guarded on status: 'PENDING' here too, not just the `fresh` read
        // above — decline/withdraw take no lock of their own, so without
        // this, one of them could still land between that read and this
        // write and get silently clobbered back to ACCEPTED.
        const claimed = await tx.bookingSwap.updateMany({ where: { id, status: 'PENDING' }, data: { status: 'ACCEPTED', respondedAt: new Date() } })
        if (claimed.count === 0) {
          throw new BookingConflictError('NOT_PENDING', 'This swap request is no longer pending')
        }
      })
    } catch (err) {
      if (err instanceof BookingConflictError) {
        return reply.status(409).send({ error: { message: err.message, code: err.code } })
      }
      throw err
    }

    await enqueueNotification({ type: NotificationType.BOOKING_SWAP_ACCEPTED, userId: swap.initiatorUserId, swapId: swap.id })
    await enqueueNotification({ type: NotificationType.BOOKING_SWAP_ACCEPTED, userId: swap.recipientUserId, swapId: swap.id })
    // BOOKING_SWAP_ACCEPTED above only sends a REQUEST for each party's *new*
    // desk — a calendar invite can only carry one event, so the desk each
    // party gave up needs its own CANCEL, sent as its own notification. Both
    // booking rows already changed owner (userId swapped) by this point, but
    // enqueueNotification's recipient is this job's own userId, independent
    // of the booking row's current owner — so this correctly reaches the
    // former owner even though the row itself now belongs to someone else.
    await enqueueNotification({ type: NotificationType.BOOKING_CANCELLED, userId: swap.initiatorUserId, bookingId: swap.bookingAId })
    await enqueueNotification({ type: NotificationType.BOOKING_CANCELLED, userId: swap.recipientUserId, bookingId: swap.bookingBId })
    dispatchWebhook('booking.swap_accepted', { id: swap.id, bookingAId: swap.bookingAId, bookingBId: swap.bookingBId, initiatorUserId: swap.initiatorUserId, recipientUserId: swap.recipientUserId }).catch(() => {})
    await recordAuditLog(prisma, {
      actorId: request.user.id,
      action: 'booking_swap.accepted',
      resourceType: 'BookingSwap',
      resourceId: id,
      before: { status: 'PENDING' },
      after: { status: 'ACCEPTED', bookingAId: swap.bookingAId, bookingBId: swap.bookingBId },
      ipAddress: request.ip,
    }, request.log)

    return reply.status(200).send({ data: { ok: true } })
  })

  // POST /bookings/swaps/:id/decline
  fastify.post('/swaps/:id/decline', { preHandler: [requireAuth] }, async (request, reply) => {
    const { id } = request.params as { id: string }
    const swap = await prisma.bookingSwap.findUnique({ where: { id } })
    if (!swap) return reply.status(404).send({ error: { message: 'Swap not found', code: 'NOT_FOUND' } })
    if (swap.recipientUserId !== request.user.id) {
      return reply.status(403).send({ error: { message: 'Forbidden', code: 'FORBIDDEN' } })
    }
    if (swap.status !== 'PENDING') {
      return reply.status(409).send({ error: { message: 'This swap request is no longer pending', code: 'NOT_PENDING' } })
    }
    // Guarded on the write itself — same reasoning as transfer decline: a
    // decline racing the initiator's own accept (which takes no lock on
    // this row) could otherwise land after accept already committed and
    // reassigned both bookings, silently overwriting the record back to
    // DECLINED with no error to either side.
    const declined = await prisma.bookingSwap.updateMany({ where: { id, status: 'PENDING' }, data: { status: 'DECLINED', respondedAt: new Date() } })
    if (declined.count === 0) {
      return reply.status(409).send({ error: { message: 'This swap request is no longer pending', code: 'NOT_PENDING' } })
    }
    await enqueueNotification({ type: NotificationType.BOOKING_SWAP_DECLINED, userId: swap.initiatorUserId, swapId: swap.id })
    dispatchWebhook('booking.swap_declined', { id: swap.id, bookingAId: swap.bookingAId, bookingBId: swap.bookingBId, initiatorUserId: swap.initiatorUserId, recipientUserId: swap.recipientUserId }).catch(() => {})
    await recordAuditLog(prisma, {
      actorId: request.user.id,
      action: 'booking_swap.declined',
      resourceType: 'BookingSwap',
      resourceId: id,
      before: { status: 'PENDING' },
      after: { status: 'DECLINED' },
      ipAddress: request.ip,
    }, request.log)
    return reply.status(200).send({ data: { ok: true } })
  })

  // DELETE /bookings/swaps/:id — initiator withdraws a still-pending request
  fastify.delete('/swaps/:id', { preHandler: [requireAuth] }, async (request, reply) => {
    const { id } = request.params as { id: string }
    const swap = await prisma.bookingSwap.findUnique({ where: { id } })
    if (!swap) return reply.status(404).send({ error: { message: 'Swap not found', code: 'NOT_FOUND' } })
    if (swap.initiatorUserId !== request.user.id) {
      return reply.status(403).send({ error: { message: 'Forbidden', code: 'FORBIDDEN' } })
    }
    if (swap.status !== 'PENDING') {
      return reply.status(409).send({ error: { message: 'This swap request is no longer pending', code: 'NOT_PENDING' } })
    }
    // Guarded on the write itself — same reasoning as transfer withdraw: a
    // withdraw racing the recipient's accept could otherwise land after
    // accept already committed and reassigned both bookings, silently
    // overwriting the record back to CANCELLED even though the swap really
    // did go through.
    const cancelled = await prisma.bookingSwap.updateMany({ where: { id, status: 'PENDING' }, data: { status: 'CANCELLED', respondedAt: new Date() } })
    if (cancelled.count === 0) {
      return reply.status(409).send({ error: { message: 'This swap request is no longer pending', code: 'NOT_PENDING' } })
    }
    await recordAuditLog(prisma, {
      actorId: request.user.id,
      action: 'booking_swap.cancelled',
      resourceType: 'BookingSwap',
      resourceId: id,
      before: { status: 'PENDING' },
      after: { status: 'CANCELLED' },
      ipAddress: request.ip,
    }, request.log)
    return reply.status(200).send({ data: { ok: true } })
  })
}
