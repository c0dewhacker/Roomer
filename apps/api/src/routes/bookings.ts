import type { FastifyInstance } from 'fastify'
import { prisma } from '../lib/prisma.js'
import { createBookingSchema, updateBookingSchema, GlobalRole, NotificationType } from '@roomer/shared'
import { requireAuth } from '../middleware/requireAuth.js'
import { isFloorManagerForFloor, getManagedBuildingIds } from '../middleware/requireRole.js'
import { enqueueNotification, fanOutFloorAvailable, promoteNextQueueEntry } from '../lib/queue.js'
import { dispatchWebhook } from '../lib/webhook.js'
import { buildBookingIcs } from '../lib/ical.js'
import { checkGroupAccess } from './groups.js'
import { assertBookable, assertUnderBookingQuota, hasConfirmedOverlap, checkZoneGroupOverlap, isWithinAdvanceBookingWindow, isNotAlreadyElapsed, lockAssetForBooking, lockUserForBookingQuota, isOverlapConstraintViolation } from '../lib/booking.js'
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

export async function bookingRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.addHook('onRoute', (route) => { route.schema = { tags: ['Bookings'], ...route.schema } })

  // GET /bookings/report — admin paginated report (SUPER_ADMIN or building admin, must be before /:id)
  fastify.get(
    '/report',
    { preHandler: [requireAuth] },
    async (request, reply) => {
      const result = reportQuerySchema.safeParse(request.query)
      if (!result.success) {
        return reply.status(400).send({
          error: { message: 'Invalid query parameters', code: 'VALIDATION_ERROR', details: result.error.flatten() },
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
      if (floorId || buildingId) {
        // Both apply together (AND), not floorId-overrides-buildingId — the
        // previous if/else-if chain silently dropped buildingId whenever
        // floorId was also supplied, even though both are independently
        // validated above and neither is reflected as ignored anywhere in
        // the response.
        where['asset'] = {
          ...(floorId ? { floorId } : {}),
          ...(buildingId ? { floor: { buildingId } } : {}),
        }
      } else if (!isSuperAdmin) {
        where['asset'] = { floor: { buildingId: { in: managedBuildingIds } } }
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
    // UTC midnight, same convention every other day-boundary calculation in
    // the app uses (directory.ts whereabouts, recurring.ts, analytics working
    // days) — local Date getters here made the boundary depend on whatever
    // TZ the API process happens to run under (no TZ=UTC pin exists in the
    // repo), so a booking that had already ended by the UTC convention could
    // still sit in the Upcoming tab with live Edit/Cancel/Check-in actions.
    const startOfToday = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()))

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

    if (!isNotAlreadyElapsed(endsAt)) {
      return reply.status(400).send({ error: { message: 'This time slot has already passed', code: 'ALREADY_ELAPSED' } })
    }

    // Centralised bookability gate (bookable / disabled / restricted / assigned / group access)
    const gate = await assertBookable(prisma, request.user, assetId, startsAt, endsAt)
    if (!gate.ok) {
      return reply.status(gate.status).send({ error: { message: gate.message, code: gate.code } })
    }

    const isSuperAdmin = request.user.globalRole === GlobalRole.SUPER_ADMIN

    if (!isSuperAdmin) {
      const org = await prisma.organisation.findFirst({ select: { maxAdvanceBookingDays: true } })
      if (!isWithinAdvanceBookingWindow(startsAt, org?.maxAdvanceBookingDays)) {
        return reply.status(400).send({
          error: { message: `Bookings cannot be made more than ${org?.maxAdvanceBookingDays} days in advance`, code: 'MAX_ADVANCE_EXCEEDED' },
        })
      }
    }

    const quota = await assertUnderBookingQuota(prisma, request.user.id, isSuperAdmin)
    if (!quota.ok) {
      return reply.status(quota.status).send({ error: { message: quota.message, code: quota.code } })
    }

    let booking: Awaited<ReturnType<typeof prisma.booking.create>>
    try {
      booking = await prisma.$transaction(async (tx) => {
        // Serialize concurrent bookings for the same asset using the shared advisory lock
        await lockAssetForBooking(tx, assetId)

        if (await hasConfirmedOverlap(tx, assetId, startsAt, endsAt)) {
          throw new BookingConflictError('ASSET_CONFLICT', 'Asset is already booked for this time')
        }

        // The quota check above ran before this transaction, against a
        // different lock domain (per-asset, not per-user) — two concurrent
        // requests from the same user targeting different assets could both
        // pass it before either commits. Re-check under a per-user lock so
        // they serialise against each other too, closing that window.
        //
        // checkZoneGroupOverlap has the exact same lock-domain problem — it's
        // also scoped per-user, not per-asset, so it must run under this same
        // lock rather than before it (where it previously sat, unprotected):
        // two concurrent bookings for different assets in the same ZoneGroup
        // each only take their own per-asset lock above, which doesn't
        // serialise them against each other.
        await lockUserForBookingQuota(tx, request.user.id)
        const quotaRecheck = await assertUnderBookingQuota(tx, request.user.id, isSuperAdmin)
        if (!quotaRecheck.ok) {
          throw new BookingConflictError(quotaRecheck.code, quotaRecheck.message)
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
      // Database-level backstop: the booking_no_overlap exclusion constraint
      if (isOverlapConstraintViolation(err)) {
        return reply.status(409).send({ error: { message: 'Asset is already booked for this time', code: 'ASSET_CONFLICT' } })
      }
      throw err
    }

    await enqueueNotification({
      type: NotificationType.BOOKING_CONFIRMED,
      userId: request.user.id,
      bookingId: booking.id,
    })

    dispatchWebhook('booking.created', { id: booking.id, userId: booking.userId, assetId: booking.assetId, startsAt: booking.startsAt, endsAt: booking.endsAt }).catch(() => {})

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

  // GET /bookings/:id/calendar.ics — download an iCalendar invite for the booking
  fastify.get('/:id/calendar.ics', { preHandler: [requireAuth] }, async (request, reply) => {
    const { id } = request.params as { id: string }
    const booking = await prisma.booking.findUnique({
      where: { id },
      include: {
        asset: {
          include: {
            floor: { select: { name: true, building: { select: { name: true } } } },
            primaryZone: { select: { name: true } },
          },
        },
      },
    })
    if (!booking) {
      return reply.status(404).send({ error: { message: 'Booking not found', code: 'NOT_FOUND' } })
    }
    if (booking.userId !== request.user.id && request.user.globalRole !== GlobalRole.SUPER_ADMIN) {
      return reply.status(403).send({ error: { message: 'Forbidden', code: 'FORBIDDEN' } })
    }

    const method = booking.status === 'CANCELLED' ? 'CANCEL' : 'PUBLISH'
    const ics = buildBookingIcs({
      id: booking.id, startsAt: booking.startsAt, endsAt: booking.endsAt,
      assetName: booking.asset.name,
      zoneName: booking.asset.primaryZone?.name,
      floorName: booking.asset.floor?.name,
      buildingName: booking.asset.floor?.building?.name,
      sequence: method === 'CANCEL' ? booking.icsSequence + 1 : booking.icsSequence,
    }, method)

    return reply
      .header('Content-Type', 'text/calendar; charset=utf-8')
      .header('Content-Disposition', `attachment; filename="booking-${booking.id}.ics"`)
      .send(ics)
  })

  // POST /bookings/:id/check-in — "I'm here". Marks the booking as occupied so
  // the no-show release job won't cancel it.
  fastify.post('/:id/check-in', { preHandler: [requireAuth] }, async (request, reply) => {
    const { id } = request.params as { id: string }
    const booking = await prisma.booking.findUnique({
      where: { id },
      select: { id: true, userId: true, assetId: true, status: true, startsAt: true, endsAt: true, checkedInAt: true },
    })
    if (!booking) {
      return reply.status(404).send({ error: { message: 'Booking not found', code: 'NOT_FOUND' } })
    }
    if (booking.userId !== request.user.id && request.user.globalRole !== GlobalRole.SUPER_ADMIN) {
      return reply.status(403).send({ error: { message: 'Forbidden', code: 'FORBIDDEN' } })
    }
    if (booking.status !== 'CONFIRMED') {
      return reply.status(409).send({ error: { message: 'Booking is not active', code: 'BOOKING_NOT_ACTIVE' } })
    }
    const now = new Date()
    if (booking.endsAt < now) {
      return reply.status(409).send({ error: { message: 'Booking has already ended', code: 'BOOKING_ENDED' } })
    }
    // "I'm here" only makes sense once the slot has actually started — without
    // this, checking in days ahead of time permanently exempts the booking
    // from no-show release (handleReleaseNoShows excludes any checkedInAt !=
    // null), letting a desk sit reserved-but-empty all day with no way for the
    // queue to ever reclaim it.
    if (booking.startsAt > now) {
      return reply.status(409).send({ error: { message: 'This booking has not started yet', code: 'BOOKING_NOT_STARTED' } })
    }
    // Idempotent — already checked in.
    if (booking.checkedInAt) {
      return reply.status(200).send({ data: { id: booking.id, checkedInAt: booking.checkedInAt } })
    }

    const updated = await prisma.booking.update({ where: { id }, data: { checkedInAt: new Date() } })
    dispatchWebhook('booking.checked_in', { id: updated.id, userId: updated.userId, assetId: updated.assetId, checkedInAt: updated.checkedInAt }).catch(() => {})
    return reply.status(200).send({ data: { id: updated.id, checkedInAt: updated.checkedInAt } })
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

    const booking = await prisma.booking.findUnique({ where: { id }, include: { asset: { include: { floor: true } } } })
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
      if (!isNotAlreadyElapsed(newEndsAt)) {
        return reply.status(400).send({ error: { message: 'This time slot has already passed', code: 'ALREADY_ELAPSED' } })
      }
      const gate = await assertBookable(prisma, request.user, booking.assetId, newStartsAt, newEndsAt)
      if (!gate.ok) {
        return reply.status(gate.status).send({ error: { message: gate.message, code: gate.code } })
      }
      if (request.user.globalRole !== GlobalRole.SUPER_ADMIN) {
        const org = await prisma.organisation.findFirst({ select: { maxAdvanceBookingDays: true } })
        if (!isWithinAdvanceBookingWindow(newStartsAt, org?.maxAdvanceBookingDays)) {
          return reply.status(400).send({
            error: { message: `Bookings cannot be made more than ${org?.maxAdvanceBookingDays} days in advance`, code: 'MAX_ADVANCE_EXCEEDED' },
          })
        }
      }
    }

    let updated: Awaited<ReturnType<typeof prisma.booking.update>>
    try {
      updated = await prisma.$transaction(async (tx) => {
        await lockAssetForBooking(tx, booking.assetId)

        if (await hasConfirmedOverlap(tx, booking.assetId, newStartsAt, newEndsAt, id)) {
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

        return tx.booking.update({
          where: { id },
          data: {
            startsAt: newStartsAt,
            endsAt: newEndsAt,
            notes: result.data.notes !== undefined ? result.data.notes : booking.notes,
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
      if (!floorId || !(await isFloorManagerForFloor(request.user.id, floorId))) {
        return reply.status(403).send({ error: { message: 'Forbidden', code: 'FORBIDDEN' } })
      }
    }

    if (booking.status !== 'CONFIRMED') {
      return reply.status(409).send({ error: { message: 'Booking is not active', code: 'BOOKING_NOT_ACTIVE' } })
    }

    // Cancel the booking
    await prisma.booking.update({ where: { id }, data: { status: 'CANCELLED' } })

    dispatchWebhook('booking.cancelled', { id: booking.id, userId: booking.userId, assetId: booking.assetId }).catch(() => {})

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
    const nextQueued = await promoteNextQueueEntry(booking.assetId, booking.startsAt, booking.endsAt)

    if (nextQueued) {
      await enqueueNotification({
        type: NotificationType.QUEUE_PROMOTED,
        userId: nextQueued.userId,
        queueEntryId: nextQueued.id,
        claimDeadline: nextQueued.claimDeadline.toISOString(),
      })

      dispatchWebhook('queue.promoted', { id: nextQueued.id, userId: nextQueued.userId, assetId: nextQueued.assetId, claimDeadline: nextQueued.claimDeadline.toISOString() }).catch(() => {})
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
      ).catch((err) => fastify.log.warn({ err }, '[bookings] floor fan-out error'))
    }

    return reply.status(200).send({ data: { ok: true } })
  })
}
