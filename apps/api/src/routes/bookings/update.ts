import type { FastifyInstance } from 'fastify'
import type { Prisma } from '@prisma/client'
import { prisma } from '../../lib/prisma.js'
import { updateBookingSchema, GlobalRole, NotificationType } from '@roomer/shared'
import { requireAuth } from '../../middleware/requireAuth.js'
import { enqueueNotification, promoteNextQueueEntry } from '../../lib/queue.js'
import { dispatchWebhook } from '../../lib/webhook.js'
import { checkGroupAccess } from '../groups.js'
import { assertBookable, hasBlockingOverlap, checkZoneGroupOverlap, isWithinAdvanceBookingWindow, isNotAlreadyElapsed, lockAssetForBooking, lockUserForBookingQuota, isOverlapConstraintViolation } from '../../lib/booking.js'
import { resolveBuildingTimezone } from '../../lib/timezone.js'
import { recordAuditLog } from '../../lib/audit.js'
import { sendGuestBookingInvite } from '../../lib/guest-booking.js'
import { BookingConflictError, updateUnchangedBooking } from '../../lib/booking-update.js'

export async function bookingUpdateRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.patch('/:id', { preHandler: [requireAuth] }, async (request, reply) => {
    const { id } = request.params as { id: string }
    const result = updateBookingSchema.safeParse(request.body)
    if (!result.success) {
      return reply.status(400).send({
        error: { message: 'Validation failed', code: 'VALIDATION_ERROR', details: result.error.flatten() },
      })
    }

    const booking = await prisma.booking.findUnique({
      where: { id },
      include: {
        asset: {
          include: {
            floor: { include: { building: true } },
            primaryZone: { select: { name: true } },
          },
        },
        user: { select: { displayName: true, globalRole: true } },
      },
    })
    if (!booking) {
      return reply.status(404).send({ error: { message: 'Booking not found', code: 'NOT_FOUND' } })
    }

    if (booking.userId !== request.user.id && request.user.globalRole !== GlobalRole.SUPER_ADMIN) {
      return reply.status(403).send({ error: { message: 'Forbidden', code: 'FORBIDDEN' } })
    }

    if (request.user.globalRole !== GlobalRole.SUPER_ADMIN && booking.asset.floor) {
      const allowed = await checkGroupAccess(request.user.id, booking.asset.floor.buildingId, booking.asset.floor.id)
      if (!allowed) {
        return reply.status(403).send({ error: { message: 'Your group does not have access to this building or floor', code: 'GROUP_ACCESS_DENIED' } })
      }
    }

    if (booking.status !== 'CONFIRMED') {
      return reply.status(409).send({ error: { message: 'Booking cannot be modified', code: 'BOOKING_NOT_MODIFIABLE' } })
    }

    const newStartsAt = result.data.startsAt ? new Date(result.data.startsAt) : booking.startsAt
    const newEndsAt = result.data.endsAt ? new Date(result.data.endsAt) : booking.endsAt

    // updateBookingSchema's refine only fires when both startsAt and endsAt are
    // present in the same request — but either can be omitted here to mean
    // "keep the existing value". A request that moves only startsAt to a time
    // at or after the *existing* endsAt (or vice versa) slips past that schema
    // check entirely. Uncaught, it reaches the booking_no_overlap exclusion
    // constraint's tsrange(startsAt, endsAt) expression, which Postgres itself
    // rejects for an inverted range — but with a raw data-exception error the
    // catch block below doesn't recognise, surfacing as an unhandled 500
    // instead of a normal validation error.
    if (newStartsAt >= newEndsAt) {
      return reply.status(400).send({ error: { message: 'startsAt must be before endsAt', code: 'VALIDATION_ERROR' } })
    }

    const timeChanged = newStartsAt.getTime() !== booking.startsAt.getTime() || newEndsAt.getTime() !== booking.endsAt.getTime()

    // Rescheduling moves the booking onto a new time slot, so it must clear the
    // same bookability gate a fresh booking would — otherwise a booking made
    // before the asset became disabled/restricted/reassigned could be rolled
    // forward indefinitely by rescheduling, since only overlap was re-checked.
    if (timeChanged) {
      // A pending swap trades this exact time slot for another booking's —
      // moving the time out from under it lets swap-accept silently move the
      // swap partner onto a slot they never agreed to (the accept handler
      // re-validates ownership/status/availability but, until now, not that
      // both sides still share the same time). A pending transfer has the
      // same issue for whoever's about to receive it. Block outright rather
      // than letting the swap/transfer's own accept-time checks catch it,
      // since the recipient may already be looking at a stale proposal.
      const [pendingSwap, pendingTransfer] = await Promise.all([
        prisma.bookingSwap.findFirst({ where: { status: 'PENDING', OR: [{ bookingAId: id }, { bookingBId: id }] } }),
        prisma.bookingTransfer.findFirst({ where: { bookingId: id, status: 'PENDING' } }),
      ])
      if (pendingSwap || pendingTransfer) {
        return reply.status(409).send({ error: { message: 'This booking has a pending swap or transfer request — resolve or cancel it before rescheduling', code: 'SWAP_ALREADY_PENDING' } })
      }
      if (!isNotAlreadyElapsed(newEndsAt)) {
        return reply.status(400).send({ error: { message: 'This time slot has already passed', code: 'ALREADY_ELAPSED' } })
      }
      // Checked against the booking's OWNER, not the acting caller — an
      // admin/floor manager rescheduling on someone else's behalf must not
      // let that person's booking silently bypass their own bookability
      // gates (RESTRICTED allow-list, ASSIGNED-desk, group access) or
      // maxAdvanceBookingDays cap just because the actor happens to be a
      // SUPER_ADMIN. Mirrors how transfer/swap-accept already check the
      // future occupant's bookability, not the acting party's.
      const gate = await assertBookable(prisma, { id: booking.userId, globalRole: booking.user.globalRole }, booking.assetId, newStartsAt, newEndsAt)
      if (!gate.ok) {
        return reply.status(gate.status).send({ error: { message: gate.message, code: gate.code } })
      }
      if (booking.user.globalRole !== GlobalRole.SUPER_ADMIN) {
        const org = await prisma.organisation.findFirst({ select: { maxAdvanceBookingDays: true } })
        if (!isWithinAdvanceBookingWindow(newStartsAt, org?.maxAdvanceBookingDays)) {
          return reply.status(400).send({
            error: { message: `Bookings cannot be made more than ${org?.maxAdvanceBookingDays} days in advance`, code: 'MAX_ADVANCE_EXCEEDED' },
          })
        }
      }
    }

    let updated: Prisma.BookingGetPayload<{ omit: { guestCheckInToken: true } }>
    try {
      updated = await prisma.$transaction(async (tx) => {
        await lockAssetForBooking(tx, booking.assetId)
        const fresh = await tx.booking.findUnique({ where: { id } })
        if (!fresh || fresh.userId !== booking.userId || fresh.status !== 'CONFIRMED' || fresh.updatedAt.getTime() !== booking.updatedAt.getTime()) {
          throw new BookingConflictError('BOOKING_CHANGED', 'This booking changed while you were editing. Reload and try again.')
        }
        if (timeChanged) {
          const gate = await assertBookable(tx, { id: booking.userId, globalRole: booking.user.globalRole }, booking.assetId, newStartsAt, newEndsAt)
          if (!gate.ok) throw new BookingConflictError(gate.code, gate.message)
          const [swap, transfer] = await Promise.all([
            tx.bookingSwap.findFirst({ where: { status: 'PENDING', OR: [{ bookingAId: id }, { bookingBId: id }] } }),
            tx.bookingTransfer.findFirst({ where: { bookingId: id, status: 'PENDING' } }),
          ])
          if (swap || transfer) throw new BookingConflictError('BOOKING_CHANGED', 'Resolve the pending swap or transfer before rescheduling.')
        }

        if (await hasBlockingOverlap(tx, booking.assetId, newStartsAt, newEndsAt, id)) {
          throw new BookingConflictError('ASSET_CONFLICT', 'Asset is already booked for this time')
        }

        // checkZoneGroupOverlap is scoped per-user (booking.userId — the
        // booking's owner, who may not be the caller if an admin/floor manager
        // is rescheduling on someone's behalf), so it needs a per-user lock to
        // actually serialise against a concurrent reschedule/booking by that
        // same user, the same reasoning POST /bookings applies. This path
        // previously had no per-user lock at all.
        await lockUserForBookingQuota(tx, booking.userId)
        if (await checkZoneGroupOverlap(tx, booking.userId, booking.assetId, newStartsAt, newEndsAt, id)) {
          throw new BookingConflictError('ZONE_GROUP_CONFLICT', 'You already have a booking in the same zone group for this time')
        }

        return updateUnchangedBooking(tx, booking, {
          // Never echo the guest check-in credential back to the client —
          // same reasoning as every other client-facing booking response
          // in this file.
          omit: { guestCheckInToken: true },
          data: {
            startsAt: newStartsAt,
            endsAt: newEndsAt,
            notes: result.data.notes !== undefined ? result.data.notes : booking.notes,
            attendeeCount: result.data.attendeeCount !== undefined ? result.data.attendeeCount : booking.attendeeCount,
            // Bumped only when the time actually changes — a notes-only edit
            // has nothing calendar-relevant to re-send, so it shouldn't move
            // the sequence a client would use to judge "is this newer".
            ...(timeChanged ? { icsSequence: { increment: 1 } } : {}),
          },
        })
      })
    } catch (err) {
      if (err instanceof BookingConflictError) {
        return reply.status(409).send({ error: { message: err.message, code: err.code } })
      }
      // Database-level backstop: the booking_no_overlap exclusion constraint
      if (isOverlapConstraintViolation(err)) {
        return reply.status(409).send({ error: { message: 'Asset is already booked for this time', code: 'ASSET_CONFLICT' } })
      }
      throw err
    }

    dispatchWebhook('booking.modified', { id: updated.id, userId: updated.userId, assetId: updated.assetId, startsAt: updated.startsAt, endsAt: updated.endsAt }).catch(() => {})
    await recordAuditLog(prisma, {
      actorId: request.user.id,
      action: 'booking.modified',
      resourceType: 'Booking',
      resourceId: id,
      before: { startsAt: booking.startsAt, endsAt: booking.endsAt, notes: booking.notes, attendeeCount: booking.attendeeCount },
      after: { startsAt: updated.startsAt, endsAt: updated.endsAt, notes: updated.notes, attendeeCount: updated.attendeeCount },
      ipAddress: request.ip,
    }, request.log)

    // Re-send the booking notification (in-app + email + a fresh .ics REQUEST
    // attachment, same rendering path as the original confirmation) whenever
    // the time actually changed. Without this, a reschedule silently drifted
    // out of sync with whatever calendar app the user added the original
    // invite to — Roomer showed the new time, their calendar still showed the
    // old one, with no notice either changed. Skipped for a notes-only edit,
    // since there's nothing calendar-relevant to re-send.
    if (timeChanged) {
      await enqueueNotification({
        type: NotificationType.BOOKING_CONFIRMED,
        userId: updated.userId,
        bookingId: updated.id,
      })

      // A guest has no in-app presence — their only record of the booking is
      // the original invite email. Without this, rescheduling silently left
      // them holding a check-in link that still works but states the old
      // time, with no notice anything changed.
      if (booking.guestName && booking.guestEmail && booking.guestCheckInToken) {
        const tz = await resolveBuildingTimezone(prisma, booking.asset.floor?.buildingId)
        await sendGuestBookingInvite(
          { id: updated.id, startsAt: newStartsAt, endsAt: newEndsAt, guestName: booking.guestName, guestEmail: booking.guestEmail, guestCheckInToken: booking.guestCheckInToken, icsSequence: updated.icsSequence },
          booking.user.displayName,
          booking.asset,
          tz,
        )
      }
    }

    // A reschedule can free up part of the original slot — shrinking it from
    // either end, or moving away from it entirely — the same way a full
    // cancellation frees the whole thing. Without this, someone queued for the
    // vacated portion would never be promoted even though it's booked by no
    // one. The freed region is [oldStart,oldEnd) minus [newStart,newEnd),
    // which is zero, one, or two disjoint sub-ranges.
    const freedRanges: Array<[Date, Date]> = []
    if (newStartsAt > booking.startsAt) {
      freedRanges.push([booking.startsAt, newStartsAt < booking.endsAt ? newStartsAt : booking.endsAt])
    }
    if (newEndsAt < booking.endsAt) {
      freedRanges.push([newEndsAt > booking.startsAt ? newEndsAt : booking.startsAt, booking.endsAt])
    }
    for (const [freedStart, freedEnd] of freedRanges) {
      const nextQueued = await promoteNextQueueEntry(booking.assetId, freedStart, freedEnd)
      if (nextQueued) {
        await enqueueNotification({
          type: NotificationType.QUEUE_PROMOTED,
          userId: nextQueued.userId,
          queueEntryId: nextQueued.id,
          claimDeadline: nextQueued.claimDeadline.toISOString(),
        })
        dispatchWebhook('queue.promoted', { id: nextQueued.id, userId: nextQueued.userId, assetId: nextQueued.assetId, claimDeadline: nextQueued.claimDeadline.toISOString() }).catch(() => {})
      }
    }

    return reply.status(200).send({ data: updated })
  })

}
