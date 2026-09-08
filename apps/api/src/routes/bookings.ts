import { bookingTransfersRoutes } from './bookings/transfers.js'
import { bookingSwapsRoutes } from './bookings/swaps.js'
import { BookingConflictError } from '../lib/booking-update.js'
import { bookingUpdateRoutes } from './bookings/update.js'
import { sendGuestBookingInvite } from '../lib/guest-booking.js'
import type { FastifyInstance } from 'fastify'
import type { Prisma } from '@prisma/client'
import { randomUUID } from 'crypto'
import { prisma } from '../lib/prisma.js'
import { createBookingSchema, GlobalRole, NotificationType } from '@roomer/shared'
import { requireAuth } from '../middleware/requireAuth.js'
import { isFloorManagerForFloor, isBuildingManagerForBuilding, getManagedBuildingIds, getManagedFloorIds, getBuildingAdminUserIds, getFloorManagerUserIds } from '../middleware/requireRole.js'
import { enqueueNotification, fanOutFloorAvailable, promoteNextQueueEntry } from '../lib/queue.js'
import { dispatchWebhook } from '../lib/webhook.js'
import { buildBookingIcs } from '../lib/ical.js'
import { sendEmail, renderGuestBookingCancelled } from '../lib/mailer.js'
import { assertBookable, assertUnderBookingQuota, hasBlockingOverlap, checkZoneGroupOverlap, isWithinAdvanceBookingWindow, isNotAlreadyElapsed, lockAssetForBooking, lockUserForBookingQuota, isOverlapConstraintViolation, resolveRequiresApproval } from '../lib/booking.js'
import { resolveBuildingTimezone, localDateStr, zonedWallClockToUtc } from '../lib/timezone.js'
import { recordAuditLog } from '../lib/audit.js'
import { z } from 'zod'

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

      const [bookings, total, org] = await Promise.all([
        prisma.booking.findMany({
          where,
          skip,
          take: limit,
          // guestCheckInToken is a bare, unauthenticated credential (see
          // POST /guest-check-in-by-token) — it must never appear in a
          // response any admin/building-manager can read, only in the
          // invite email actually sent to the guest.
          omit: { guestCheckInToken: true },
          include: {
            user: { select: { id: true, displayName: true, email: true } },
            asset: {
              include: {
                floor: { include: { building: { select: { id: true, name: true, timezone: true } } } },
                primaryZone: { select: { id: true, name: true } },
              },
            },
          },
          // Secondary sort on id — startsAt is not unique (many bookings
          // routinely share the same slot start, e.g. everyone booking a
          // desk "for the day"), and Postgres gives no ordering guarantee
          // among tied rows across two separate query executions unless a
          // unique tiebreaker is included. Without one, a row among a tied
          // group can shift position between page fetches (e.g. the
          // 30-minute auto-complete sweep in queue.ts updates elapsed
          // bookings' status, rewriting those rows) — handleExportAll's
          // page-by-page CSV walk (BookingsReportPage.tsx) can then see the
          // same booking twice or skip one entirely at a page boundary, and
          // the plain paginated UI table has the same instability on Next/
          // Previous.
          orderBy: [{ startsAt: 'desc' }, { id: 'asc' }],
        }),
        prisma.booking.count({ where }),
        prisma.organisation.findFirst({ select: { defaultTimezone: true } }),
      ])

      // Same resolvedTimezone every other booking-list endpoint in this file
      // attaches (see GET / above and GET /pending-approvals) — without it,
      // this report rendered every booking's time in the viewer's own
      // browser timezone (on screen) and as a raw UTC ISO string (in the
      // CSV export), neither of which matches the building-local time the
      // booking was actually made for, or how the same booking displays
      // anywhere else in the app.
      const data = bookings.map((b) => ({
        ...b,
        resolvedTimezone: b.asset.floor?.building?.timezone ?? org?.defaultTimezone ?? 'UTC',
      }))

      return reply.status(200).send({
        data,
        meta: { page, limit, total, totalPages: Math.ceil(total / limit) },
      })
    },
  )

  // GET /bookings/pending-approvals — bookings awaiting approval that the
  // caller can act on (SUPER_ADMIN sees all; otherwise scoped to buildings/
  // floors they manage — see #74's approver audience). Must be registered
  // before GET /:id so "pending-approvals" doesn't get parsed as a booking id.
  fastify.get('/pending-approvals', { preHandler: [requireAuth] }, async (request, reply) => {
    const isSuperAdmin = request.user.globalRole === GlobalRole.SUPER_ADMIN
    const where: Prisma.BookingWhereInput = { status: 'PENDING_APPROVAL' }

    if (!isSuperAdmin) {
      const [managedBuildingIds, managedFloorIds] = await Promise.all([
        getManagedBuildingIds(request.user.id),
        getManagedFloorIds(request.user.id),
      ])
      if (managedBuildingIds.length === 0 && managedFloorIds.length === 0) {
        return reply.status(200).send({ data: [] })
      }
      where.asset = {
        floor: {
          OR: [
            { buildingId: { in: managedBuildingIds } },
            { id: { in: managedFloorIds } },
          ],
        },
      }
    }

    const [bookings, org] = await Promise.all([
      prisma.booking.findMany({
        where,
        // Same reasoning as GET /report — an approver reviewing a guest
        // booking has no legitimate reason to read the guest's own
        // check-in credential.
        omit: { guestCheckInToken: true },
        include: {
          user: { select: { id: true, displayName: true, email: true } },
          asset: { select: { id: true, name: true, floor: { select: { id: true, name: true, building: { select: { id: true, name: true, timezone: true } } } } } },
        },
        orderBy: { createdAt: 'asc' },
      }),
      prisma.organisation.findFirst({ select: { defaultTimezone: true } }),
    ])

    // Same resolvedTimezone convention as GET /bookings (#72) — without it,
    // an approver has no way to tell what time they're actually approving:
    // startsAt/endsAt are UTC instants, and the admin UI has no other source
    // for which building-local time they correspond to.
    const data = bookings.map((b) => ({
      ...b,
      resolvedTimezone: b.asset.floor?.building?.timezone ?? org?.defaultTimezone ?? 'UTC',
    }))

    return reply.status(200).send({ data })
  })

  // GET /bookings — current user's bookings
  fastify.get('/', { preHandler: [requireAuth] }, async (request, reply) => {
    const queryResult = z.object({ status: z.enum(['past', 'all', 'upcoming']).optional() }).safeParse(request.query)
    if (!queryResult.success) {
      return reply.status(400).send({ error: { message: 'Invalid query parameters', code: 'VALIDATION_ERROR' } })
    }
    const { status } = queryResult.data
    const now = new Date()
    // Widened DB pre-filter only — a user's bookings can span buildings in
    // different timezones, so no single global cutoff can define "today"
    // correctly for all of them at once (same reasoning as directory.ts's
    // /whereabouts ±14h widen-then-precise-filter). A single global UTC-
    // midnight cutoff (the previous approach here) put a Sydney-local booking
    // that's still "today" in Sydney terms into the wrong bucket whenever its
    // UTC instant crossed into the previous/next UTC calendar day. The
    // precise per-booking check below (once each row's own resolvedTimezone
    // is known) does the real work; ±26h margin covers every real-world UTC
    // offset (max +14) either direction with room to spare.
    const WIDEN_MS = 26 * 60 * 60 * 1000
    const where: Record<string, unknown> = { userId: request.user.id }

    if (status === 'past') {
      where['endsAt'] = { lt: new Date(now.getTime() + WIDEN_MS) }
    } else if (status === 'all') {
      // No filter
    } else {
      // Default: upcoming — include all of today regardless of time.
      // PENDING_APPROVAL is included alongside CONFIRMED (see #74) — it's
      // reserving the same slot and the requester still needs to see it
      // (and be able to withdraw it) here, not just once it's approved.
      where['endsAt'] = { gte: new Date(now.getTime() - WIDEN_MS) }
      where['status'] = { in: ['CONFIRMED', 'PENDING_APPROVAL'] }
    }

    const [bookings, org] = await Promise.all([
      prisma.booking.findMany({
        where,
        omit: { guestCheckInToken: true },
        include: {
          asset: {
            include: {
              floor: { include: { building: { select: { id: true, name: true, qrCheckInMode: true, timezone: true } } } },
              primaryZone: { select: { id: true, name: true } },
            },
          },
        },
        orderBy: { startsAt: 'asc' },
      }),
      // Resolved (not raw) QR mode + timezone per booking — floor → building →
      // org, same order as everywhere else this resolves. The frontend uses
      // qrCheckInMode purely to decide whether to show the manual "I'm here"
      // check-in button (hidden under MANDATORY), and resolvedTimezone (see
      // #72) to render this booking's time in its actual building-local time
      // rather than the viewer's own browser timezone.
      prisma.organisation.findFirst({ select: { qrCheckInMode: true, defaultTimezone: true } }),
    ])

    // Precise past/upcoming split: is "today" (in *this booking's own*
    // building timezone) before or at-or-after its endsAt? Replaces the
    // widened DB filter above as the actual source of truth.
    const finalBookings = status === 'all' ? bookings : bookings.filter((b) => {
      const tz = b.asset.floor?.building?.timezone ?? org?.defaultTimezone ?? 'UTC'
      const [y, m, d] = localDateStr(now, tz).split('-').map(Number)
      const localStartOfToday = zonedWallClockToUtc(y, m, d, 0, 0, tz)
      return status === 'past' ? b.endsAt < localStartOfToday : b.endsAt >= localStartOfToday
    })

    const data = finalBookings.map((b) => ({
      ...b,
      qrCheckInMode: b.asset.floor?.qrCheckInMode ?? b.asset.floor?.building?.qrCheckInMode ?? org?.qrCheckInMode ?? 'DISABLED',
      resolvedTimezone: b.asset.floor?.building?.timezone ?? org?.defaultTimezone ?? 'UTC',
    }))

    return reply.status(200).send({ data, meta: { total: finalBookings.length } })
  })

  // POST /bookings — create booking
  fastify.post('/', { preHandler: [requireAuth] }, async (request, reply) => {
    const result = createBookingSchema.safeParse(request.body)
    if (!result.success) {
      return reply.status(400).send({
        error: { message: 'Validation failed', code: 'VALIDATION_ERROR', details: result.error.flatten() },
      })
    }

    const { assetId, notes, attendeeCount, guestName, guestEmail } = result.data
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

    const quota = await assertUnderBookingQuota(prisma, request.user.id, isSuperAdmin, !!guestName)
    if (!quota.ok) {
      return reply.status(quota.status).send({ error: { message: quota.message, code: quota.code } })
    }

    // Zone → building → org override chain (see #74's feasibility
    // assessment). A PENDING_APPROVAL booking reserves the slot exactly like
    // CONFIRMED (hasBlockingOverlap, checkZoneGroupOverlap, the booking quota
    // count, and the booking_no_overlap DB constraint all treat the two
    // statuses identically) — approval only gates whether it starts life
    // confirmed or waiting on a reviewer, not whether the slot is held.
    const requiresApproval = await resolveRequiresApproval(prisma, assetId)
    const approvalWindowHours = requiresApproval
      ? (await prisma.organisation.findFirst({ select: { approvalWindowHours: true } }))?.approvalWindowHours ?? 24
      : 0

    // Minted here (not read back off the created row) because the create
    // response omits guestCheckInToken from the client-facing object below —
    // this local value is the only copy needed to actually send the invite.
    const guestCheckInToken = guestName && guestEmail ? randomUUID() : null

    let booking: Prisma.BookingGetPayload<{
      omit: { guestCheckInToken: true }
      include: {
        asset: {
          include: {
            floor: { include: { building: { select: { id: true; name: true } } } }
            primaryZone: { select: { id: true; name: true } }
          }
        }
      }
    }>
    try {
      booking = await prisma.$transaction(async (tx) => {
        // Serialize concurrent bookings for the same asset using the shared advisory lock
        await lockAssetForBooking(tx, assetId)

        if (await hasBlockingOverlap(tx, assetId, startsAt, endsAt)) {
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
        const quotaRecheck = await assertUnderBookingQuota(tx, request.user.id, isSuperAdmin, !!guestName)
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
            attendeeCount,
            status: requiresApproval ? 'PENDING_APPROVAL' : 'CONFIRMED',
            approvalExpiresAt: requiresApproval ? new Date(Date.now() + approvalWindowHours * 60 * 60 * 1000) : null,
            guestName: guestName ?? null,
            guestEmail: guestEmail ?? null,
            guestCheckInToken,
          },
          // Never echo the minted check-in credential back in the create
          // response — the host doesn't need it (they didn't need to see it
          // to create the booking) and it should only ever exist in the
          // one invite email actually sent to the guest.
          omit: { guestCheckInToken: true },
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

    if (booking.status === 'PENDING_APPROVAL') {
      // Notified once per approver (SUPER_ADMIN + building admins + floor
      // managers) rather than a BOOKING_CONFIRMED to the requester — nothing
      // is confirmed yet. booking.created is deliberately withheld until an
      // approve actually confirms it (see POST /:id/approve), so an
      // integration reconciling desk occupancy off that webhook never sees a
      // slot as occupied before a human has actually signed off on it.
      const floorId = booking.asset.floor?.id
      const buildingId = booking.asset.floor?.buildingId
      const [superAdmins, buildingAdminIds, floorManagerIds] = await Promise.all([
        prisma.user.findMany({ where: { globalRole: 'SUPER_ADMIN', accountStatus: 'ACTIVE' }, select: { id: true } }),
        buildingId ? getBuildingAdminUserIds(buildingId) : Promise.resolve([]),
        floorId ? getFloorManagerUserIds(floorId) : Promise.resolve([]),
      ])
      const approverIds = [...new Set([...superAdmins.map((a) => a.id), ...buildingAdminIds, ...floorManagerIds])]
        .filter((id) => id !== request.user.id)
      for (const userId of approverIds) {
        await enqueueNotification({
          type: NotificationType.BOOKING_PENDING_APPROVAL,
          userId,
          bookingId: booking.id,
        })
      }
    } else {
      await enqueueNotification({
        type: NotificationType.BOOKING_CONFIRMED,
        userId: request.user.id,
        bookingId: booking.id,
      })

      dispatchWebhook('booking.created', { id: booking.id, userId: booking.userId, assetId: booking.assetId, startsAt: booking.startsAt, endsAt: booking.endsAt }).catch(() => {})

      if (booking.guestName && booking.guestEmail && guestCheckInToken) {
        const tz = await resolveBuildingTimezone(prisma, booking.asset.floor?.building?.id)
        await sendGuestBookingInvite(
          { id: booking.id, startsAt: booking.startsAt, endsAt: booking.endsAt, guestName: booking.guestName, guestEmail: booking.guestEmail, guestCheckInToken, icsSequence: booking.icsSequence },
          request.user.displayName,
          booking.asset,
          tz,
        )
      }
    }

    await recordAuditLog(prisma, {
      actorId: request.user.id,
      action: 'booking.created',
      resourceType: 'Booking',
      resourceId: booking.id,
      after: { assetId: booking.assetId, startsAt: booking.startsAt, endsAt: booking.endsAt, status: booking.status, guestName: booking.guestName },
      ipAddress: request.ip,
    }, request.log)

    return reply.status(201).send({ data: booking })
  })

  // GET /bookings/:id — single booking
  fastify.get('/:id', { preHandler: [requireAuth] }, async (request, reply) => {
    const { id } = request.params as { id: string }

    const booking = await prisma.booking.findUnique({
      where: { id },
      omit: { guestCheckInToken: true },
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
        user: { select: { email: true, displayName: true } },
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
      // The booking's actual owner, not necessarily the caller — a
      // SUPER_ADMIN can download this on the owner's behalf.
      attendeeEmail: booking.user.email, attendeeName: booking.user.displayName,
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

    // Conditioned on status: 'CONFIRMED' AND checkedInAt: null, not a bare
    // update-by-id — the status half closes the race against
    // handleReleaseNoShows (if the no-show sweep cancels this exact booking
    // in the gap between the status check above and this write, a plain
    // update-by-id would still stamp a checkedInAt onto a row that's already
    // CANCELLED). The checkedInAt half closes a *different* race: two
    // check-in requests for the same booking in flight at once (a
    // double-click, a client retry) both pass the in-memory checkedInAt-null
    // check above before either commits — without this guard both writes
    // would succeed, double-firing the webhook/audit-log entry below for a
    // single physical check-in.
    const result = await prisma.booking.updateMany({ where: { id, status: 'CONFIRMED', checkedInAt: null }, data: { checkedInAt: new Date() } })
    if (result.count === 0) {
      // Lost the race — could be a concurrent check-in (idempotent replay)
      // or an actual state change (cancelled/no-showed underneath us).
      // Distinguish so a same-instant double-submit gets the same 200 the
      // first request saw, not a misleading "not active" error.
      const current = await prisma.booking.findUnique({ where: { id }, select: { status: true, checkedInAt: true } })
      if (current?.status === 'CONFIRMED' && current.checkedInAt) {
        return reply.status(200).send({ data: { id, checkedInAt: current.checkedInAt } })
      }
      return reply.status(409).send({ error: { message: 'Booking is not active', code: 'BOOKING_NOT_ACTIVE' } })
    }
    const updated = await prisma.booking.findUniqueOrThrow({ where: { id } })
    dispatchWebhook('booking.checked_in', { id: updated.id, userId: updated.userId, assetId: updated.assetId, checkedInAt: updated.checkedInAt }).catch(() => {})
    await recordAuditLog(prisma, {
      actorId: request.user.id,
      action: 'booking.checked_in',
      resourceType: 'Booking',
      resourceId: id,
      after: { checkedInAt: updated.checkedInAt },
      ipAddress: request.ip,
    }, request.log)
    return reply.status(200).send({ data: { id: updated.id, checkedInAt: updated.checkedInAt } })
  })

  // POST /bookings/guest-check-in-by-token — one-click check-in for a guest
  // (see #79), who has no account/session to use the authenticated check-in
  // route above. Mirrors /queue/claim-by-token: unauthenticated, rate-limited,
  // and does not identify who else's bookings exist (a 404-shaped response
  // for "wrong token" and "already checked in" alike, mirroring the token
  // itself as the only credential).
  fastify.post('/guest-check-in-by-token', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (request, reply) => {
    const result = z.object({ token: z.string().min(1) }).safeParse(request.body)
    if (!result.success) {
      return reply.status(400).send({ error: { message: 'Validation failed', code: 'VALIDATION_ERROR' } })
    }
    const booking = await prisma.booking.findUnique({
      where: { guestCheckInToken: result.data.token },
      select: { id: true, assetId: true, userId: true, status: true, startsAt: true, endsAt: true, checkedInAt: true, guestName: true },
    })
    if (!booking) {
      return reply.status(404).send({ error: { message: 'Invalid or expired check-in link', code: 'NOT_FOUND' } })
    }
    if (booking.status !== 'CONFIRMED') {
      return reply.status(409).send({ error: { message: 'This booking is no longer active', code: 'BOOKING_NOT_ACTIVE' } })
    }
    const now = new Date()
    if (booking.endsAt < now) {
      return reply.status(409).send({ error: { message: 'This booking has already ended', code: 'BOOKING_ENDED' } })
    }
    if (booking.startsAt > now) {
      return reply.status(409).send({ error: { message: 'This booking has not started yet', code: 'BOOKING_NOT_STARTED' } })
    }
    if (booking.checkedInAt) {
      return reply.status(200).send({ data: { guestName: booking.guestName, checkedInAt: booking.checkedInAt } })
    }

    // Deliberately does NOT clear guestCheckInToken here, despite the schema
    // comment describing it as "cleared once used": this lookup finds the
    // booking BY that token (see the findUnique above), and the idempotent
    // "already checked in" replay a few lines up depends on being able to
    // find the same booking again on a second visit to the same link. Nulling
    // it here would make a repeat visit 404 instead of replaying successfully.
    // It's still cleared once the booking is no longer CONFIRMED (see the
    // cancel path below), which closes the other half of that contract
    // without breaking this one.
    // Conditioned on status: 'CONFIRMED' AND checkedInAt: null, not a bare
    // update-by-id — see the authenticated check-in route above for why
    // (closes both the race against handleReleaseNoShows and a concurrent
    // duplicate submission of this same link).
    const checkInResult = await prisma.booking.updateMany({ where: { id: booking.id, status: 'CONFIRMED', checkedInAt: null }, data: { checkedInAt: now } })
    if (checkInResult.count === 0) {
      const current = await prisma.booking.findUnique({ where: { id: booking.id }, select: { status: true, checkedInAt: true } })
      if (current?.status === 'CONFIRMED' && current.checkedInAt) {
        return reply.status(200).send({ data: { guestName: booking.guestName, checkedInAt: current.checkedInAt } })
      }
      return reply.status(409).send({ error: { message: 'This booking is no longer active', code: 'BOOKING_NOT_ACTIVE' } })
    }
    const updated = await prisma.booking.findUniqueOrThrow({ where: { id: booking.id } })
    dispatchWebhook('booking.checked_in', { id: updated.id, userId: updated.userId, assetId: updated.assetId, checkedInAt: updated.checkedInAt }).catch(() => {})
    // actorId is the booking's own owner — this endpoint is deliberately
    // unauthenticated (a guest check-in link), but the identity is known
    // exactly via the booking it's tied to, not a system/cron action.
    await recordAuditLog(prisma, {
      actorId: updated.userId,
      action: 'booking.guest_checked_in',
      resourceType: 'Booking',
      resourceId: updated.id,
      after: { checkedInAt: updated.checkedInAt },
      ipAddress: request.ip,
    }, request.log)
    return reply.status(200).send({ data: { guestName: booking.guestName, checkedInAt: updated.checkedInAt } })
  })

  // PATCH /bookings/:id — modify booking
  await bookingUpdateRoutes(fastify)

  // DELETE /bookings/:id — cancel booking
  fastify.delete('/:id', { preHandler: [requireAuth] }, async (request, reply) => {
    const { id } = request.params as { id: string }

    const booking = await prisma.booking.findUnique({
      where: { id },
      include: {
        asset: {
          include: {
            floor: { include: { building: true } },
            primaryZone: { select: { name: true } },
          },
        },
        user: { select: { displayName: true } },
      },
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

    // PENDING_APPROVAL is included so the requester (or an admin/floor
    // manager) can withdraw a booking that's still awaiting sign-off — see
    // #74. It still reserves the slot, so withdrawing it must free that slot
    // for the queue the same way cancelling a CONFIRMED booking does, hence
    // no separate branch below: the promote/fan-out logic already applies
    // uniformly regardless of which status was cancelled.
    if (booking.status !== 'CONFIRMED' && booking.status !== 'PENDING_APPROVAL') {
      return reply.status(409).send({ error: { message: 'Booking is not active', code: 'BOOKING_NOT_ACTIVE' } })
    }

    // Cancel the booking. Claimed atomically (updateMany + status guard),
    // same pattern /approve and /reject already use — an unconditional
    // update() here let two concurrent cancel requests for the same booking
    // (a double-click, or the owner and a floor manager racing) both pass
    // the status check above and both run the full promote/notify pipeline
    // below, double-promoting the queue for one single freed slot. The
    // guest check-in token is cleared here too — schema.prisma documents it
    // as "cleared once used or once the booking is no longer CONFIRMED"
    // (mirroring QueueEntry.claimToken's single-use pattern), but it was
    // previously never actually nulled anywhere. Not exploitable today (the
    // public check-in route independently gates on status === 'CONFIRMED'),
    // but leaving a dead token sitting in the DB indefinitely contradicts
    // the documented contract and is exactly the kind of latent gap that
    // becomes a real bug the next time this code is touched.
    const claimed = await prisma.booking.updateMany({
      where: { id, userId: booking.userId, status: { in: ['CONFIRMED', 'PENDING_APPROVAL'] } },
      data: { status: 'CANCELLED', guestCheckInToken: null },
    })
    if (claimed.count === 0) {
      return reply.status(409).send({ error: { message: 'Booking is not active', code: 'BOOKING_NOT_ACTIVE' } })
    }

    dispatchWebhook('booking.cancelled', { id: booking.id, userId: booking.userId, assetId: booking.assetId }).catch(() => {})
    await recordAuditLog(prisma, {
      actorId: request.user.id,
      action: 'booking.cancelled',
      resourceType: 'Booking',
      resourceId: id,
      before: { status: booking.status, startsAt: booking.startsAt, endsAt: booking.endsAt },
      after: { status: 'CANCELLED' },
      ipAddress: request.ip,
    }, request.log)

    // Notify the original booker
    const notificationType = !isSelf
      ? NotificationType.BOOKING_CANCELLED_BY_ADMIN
      : NotificationType.BOOKING_CANCELLED

    await enqueueNotification({
      type: notificationType,
      userId: booking.userId,
      bookingId: id,
    })

    // A guest has no in-app presence — without this they only ever found out
    // their visit was cancelled by trying a now-dead check-in link on the
    // day, with no explanation.
    if (booking.guestName && booking.guestEmail) {
      const tz = await resolveBuildingTimezone(prisma, booking.asset.floor?.buildingId)
      const { subject, html, text } = renderGuestBookingCancelled(booking.guestName, booking.user, booking, booking.asset, tz)
      const icalEvent = {
        method: 'CANCEL',
        content: buildBookingIcs({
          id: booking.id, startsAt: booking.startsAt, endsAt: booking.endsAt,
          assetName: booking.asset.name, zoneName: booking.asset.primaryZone?.name,
          floorName: booking.asset.floor?.name, buildingName: booking.asset.floor?.building?.name,
          sequence: booking.icsSequence + 1,
          attendeeEmail: booking.guestEmail, attendeeName: booking.guestName,
        }, 'CANCEL'),
      }
      await sendEmail({ to: booking.guestEmail, subject, html, text, icalEvent }).catch(() => {})
    }

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
      select: { floorId: true, primaryZoneId: true, floor: { select: { buildingId: true } } },
    })
    if (cancelledAsset?.floorId) {
      const tz = await resolveBuildingTimezone(prisma, cancelledAsset.floor?.buildingId ?? null)
      const slotDate = localDateStr(booking.startsAt, tz)
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

  // Releases a slot freed by rejecting/withdrawing a PENDING_APPROVAL booking:
  // promotes the next queue entry for that asset/time (if any) and fans out
  // the newly-available slot to floor subscribers. Same two steps DELETE
  // /:id already does for a CONFIRMED cancellation — factored out here since
  // reject needs it per-occurrence for both a single booking and every
  // occurrence in a rejected recurring series.
  async function releaseRejectedSlot(assetId: string, startsAt: Date, endsAt: Date, requesterUserId: string): Promise<void> {
    const nextQueued = await promoteNextQueueEntry(assetId, startsAt, endsAt)
    if (nextQueued) {
      await enqueueNotification({
        type: NotificationType.QUEUE_PROMOTED,
        userId: nextQueued.userId,
        queueEntryId: nextQueued.id,
        claimDeadline: nextQueued.claimDeadline.toISOString(),
      })
      dispatchWebhook('queue.promoted', { id: nextQueued.id, userId: nextQueued.userId, assetId: nextQueued.assetId, claimDeadline: nextQueued.claimDeadline.toISOString() }).catch(() => {})
    }
    const asset = await prisma.asset.findUnique({ where: { id: assetId }, select: { floorId: true, primaryZoneId: true, floor: { select: { buildingId: true } } } })
    if (asset?.floorId) {
      const tz = await resolveBuildingTimezone(prisma, asset.floor?.buildingId ?? null)
      const slotDate = localDateStr(startsAt, tz)
      await fanOutFloorAvailable(assetId, asset.floorId, asset.primaryZoneId, slotDate, requesterUserId)
        .catch((err) => fastify.log.warn({ err }, '[bookings] floor fan-out error'))
    }
  }

  // True when the caller may approve/reject a PENDING_APPROVAL booking on
  // this asset: SUPER_ADMIN, a building admin for the asset's building, or a
  // floor manager for the asset's floor — the same approver audience that
  // was notified when the booking was first requested (see POST / above).
  async function canReviewApproval(userId: string, isSuperAdmin: boolean, floorId: string | null | undefined, buildingId: string | null | undefined): Promise<boolean> {
    if (isSuperAdmin) return true
    if (buildingId && (await isBuildingManagerForBuilding(userId, buildingId))) return true
    if (floorId && (await isFloorManagerForFloor(userId, floorId))) return true
    return false
  }

  // POST /bookings/:id/approve — confirm a PENDING_APPROVAL booking. If the
  // booking belongs to a recurring series, approves every PENDING_APPROVAL
  // occurrence in that rule together (a series is one approval decision, not
  // one per occurrence — see #74's feasibility assessment).
  fastify.post('/:id/approve', { preHandler: [requireAuth] }, async (request, reply) => {
    const { id } = request.params as { id: string }
    const booking = await prisma.booking.findUnique({
      where: { id },
      include: {
        asset: {
          select: {
            name: true, floorId: true,
            floor: { select: { buildingId: true, name: true, building: { select: { name: true } } } },
            primaryZone: { select: { name: true } },
          },
        },
        user: { select: { displayName: true } },
      },
    })
    if (!booking) {
      return reply.status(404).send({ error: { message: 'Booking not found', code: 'NOT_FOUND' } })
    }
    const isSuperAdmin = request.user.globalRole === GlobalRole.SUPER_ADMIN
    if (!(await canReviewApproval(request.user.id, isSuperAdmin, booking.asset.floorId, booking.asset.floor?.buildingId))) {
      return reply.status(403).send({ error: { message: 'Forbidden', code: 'FORBIDDEN' } })
    }
    if (booking.status !== 'PENDING_APPROVAL') {
      return reply.status(409).send({ error: { message: 'Booking is not pending approval', code: 'BOOKING_NOT_PENDING' } })
    }
    // A standalone booking whose slot has already ended shouldn't be
    // confirmable after the fact (same isNotAlreadyElapsed guard reschedule/
    // transfer/swap already use) — nothing previously stopped an approver
    // from confirming, webhook-firing, and (for a guest booking) emailing a
    // calendar invite for a meeting that already happened. Checked upfront
    // only here, not for a recurring series: approving is a single
    // whole-series decision, so an elapsed occurrence there is instead
    // simply excluded from what gets claimed below, without failing the
    // still-valid rest of the series.
    if (!booking.recurringRuleId && !isNotAlreadyElapsed(booking.endsAt)) {
      return reply.status(409).send({ error: { message: 'This booking has already ended', code: 'ALREADY_ELAPSED' } })
    }

    const now = new Date()
    const affected = booking.recurringRuleId
      ? await prisma.booking.findMany({
          where: { recurringRuleId: booking.recurringRuleId, status: 'PENDING_APPROVAL' },
          select: { id: true, assetId: true, startsAt: true, endsAt: true },
          orderBy: { startsAt: 'asc' },
        })
      : [{ id: booking.id, assetId: booking.assetId, startsAt: booking.startsAt, endsAt: booking.endsAt }]

    // Claimed atomically (status: 'PENDING_APPROVAL' + endsAt guard), not an
    // unconditional update — otherwise this can race a concurrent reject (or
    // the auto-reject-pending-approvals cron) that read PENDING_APPROVAL
    // before either commits: whichever side's write lands last would
    // silently overwrite the other's status with no error, while BOTH
    // sides' webhooks/notifications/audit rows still fire — a booking that
    // ends up CANCELLED can still get a booking.created webhook and a
    // BOOKING_APPROVED email, or (worse) one that ends up CONFIRMED can
    // still have releaseRejectedSlot hand its still-occupied slot to the
    // next queued user, a real path to a double-booked desk. The endsAt
    // filter is the recurring-series half of the elapsed guard above: an
    // occurrence that ended before this call reached the database is
    // silently left PENDING_APPROVAL (for the auto-reject cron to clean up)
    // rather than confirmed after the fact.
    const claimed = await prisma.booking.updateMany({
      where: { id: { in: affected.map((b) => b.id) }, status: 'PENDING_APPROVAL', endsAt: { gt: now } },
      data: { status: 'CONFIRMED', approvedAt: now, approvedByUserId: request.user.id, approvalExpiresAt: null },
    })
    if (claimed.count === 0) {
      return reply.status(409).send({ error: { message: 'Booking is not pending approval', code: 'BOOKING_NOT_PENDING' } })
    }

    // Re-derive from what the write actually claimed, not the pre-write
    // `affected` snapshot — for a recurring series, one of its occurrences
    // can be individually withdrawn (DELETE /:id is not recurringRuleId-
    // scoped and allows this) in the gap between the findMany above and the
    // guarded updateMany. Looping over the stale `affected` list would still
    // fire a booking.created webhook for an occurrence that's actually
    // CANCELLED. None of `affected`'s ids could have been CONFIRMED before
    // this call (the findMany above only selected PENDING_APPROVAL rows), so
    // filtering the same id set down to status: 'CONFIRMED' now correctly
    // identifies exactly the rows this call flipped.
    const actuallyApproved = await prisma.booking.findMany({
      where: { id: { in: affected.map((b) => b.id) }, status: 'CONFIRMED' },
      select: { id: true, assetId: true, startsAt: true, endsAt: true },
      orderBy: { startsAt: 'asc' },
    })

    for (const b of actuallyApproved) {
      dispatchWebhook('booking.created', { id: b.id, userId: booking.userId, assetId: b.assetId, startsAt: b.startsAt, endsAt: b.endsAt }).catch(() => {})
    }
    // One notification for the whole approval decision, referencing the
    // earliest occurrence — same dedup reasoning as recurring creation's
    // single BOOKING_CONFIRMED (see POST /recurring-bookings).
    await enqueueNotification({
      type: NotificationType.BOOKING_APPROVED,
      userId: booking.userId,
      bookingId: actuallyApproved[0].id,
    })

    // A guest booking (see #79) never got its invite at creation time if it
    // needed approval first (see POST /) — send it now that it's actually
    // confirmed. Guest bookings are never recurring, so `booking` itself
    // (not `affected`) always has the right dates here.
    if (booking.guestName && booking.guestEmail && booking.guestCheckInToken) {
      const tz = await resolveBuildingTimezone(prisma, booking.asset.floor?.buildingId)
      await sendGuestBookingInvite(
        { id: booking.id, startsAt: booking.startsAt, endsAt: booking.endsAt, guestName: booking.guestName, guestEmail: booking.guestEmail, guestCheckInToken: booking.guestCheckInToken, icsSequence: booking.icsSequence },
        booking.user.displayName,
        booking.asset,
        tz,
      )
    }

    // One summary row for the whole decision, not one per occurrence — a
    // recurring series' pending occurrences are approved as a single unit.
    await recordAuditLog(prisma, {
      actorId: request.user.id,
      action: 'booking.approved',
      resourceType: 'Booking',
      resourceId: id,
      before: { status: 'PENDING_APPROVAL' },
      after: { status: 'CONFIRMED', approvedCount: claimed.count },
      ipAddress: request.ip,
    }, request.log)

    return reply.status(200).send({ data: { ok: true, approvedCount: claimed.count } })
  })

  const rejectBookingSchema = z.object({ note: z.string().max(1000).optional() })

  // POST /bookings/:id/reject — decline a PENDING_APPROVAL booking, freeing
  // its slot. Recurring series are rejected as a whole, same as approve.
  fastify.post('/:id/reject', { preHandler: [requireAuth] }, async (request, reply) => {
    const { id } = request.params as { id: string }
    const result = rejectBookingSchema.safeParse(request.body ?? {})
    if (!result.success) {
      return reply.status(400).send({ error: { message: 'Validation failed', code: 'VALIDATION_ERROR', details: result.error.flatten() } })
    }
    const booking = await prisma.booking.findUnique({
      where: { id },
      include: { asset: { select: { floorId: true, floor: { select: { buildingId: true } } } } },
    })
    if (!booking) {
      return reply.status(404).send({ error: { message: 'Booking not found', code: 'NOT_FOUND' } })
    }
    const isSuperAdmin = request.user.globalRole === GlobalRole.SUPER_ADMIN
    if (!(await canReviewApproval(request.user.id, isSuperAdmin, booking.asset.floorId, booking.asset.floor?.buildingId))) {
      return reply.status(403).send({ error: { message: 'Forbidden', code: 'FORBIDDEN' } })
    }
    if (booking.status !== 'PENDING_APPROVAL') {
      return reply.status(409).send({ error: { message: 'Booking is not pending approval', code: 'BOOKING_NOT_PENDING' } })
    }

    const note = result.data.note ?? null
    const affected = booking.recurringRuleId
      ? await prisma.booking.findMany({
          where: { recurringRuleId: booking.recurringRuleId, status: 'PENDING_APPROVAL' },
          select: { id: true, assetId: true, startsAt: true, endsAt: true },
          orderBy: { startsAt: 'asc' },
        })
      : [{ id: booking.id, assetId: booking.assetId, startsAt: booking.startsAt, endsAt: booking.endsAt }]

    // Claimed atomically (status: 'PENDING_APPROVAL' guard), not an
    // unconditional update — same reasoning as approve above: without this,
    // a concurrent approve (or the auto-reject-pending-approvals cron) could
    // race this call, and whichever write lands last silently overwrites the
    // other's status while both sides' webhooks/notifications/audit rows
    // still fire regardless. The recurring-rule cancellation is only applied
    // if this call actually won the claim — an interactive transaction
    // (rather than the array form) is needed so that second statement can be
    // conditional on the first's result.
    const claimedCount = await prisma.$transaction(async (tx) => {
      const claimed = await tx.booking.updateMany({
        where: { id: { in: affected.map((b) => b.id) }, status: 'PENDING_APPROVAL' },
        data: { status: 'CANCELLED', rejectionNote: note, approvedByUserId: request.user.id, approvalExpiresAt: null },
      })
      // A rejected series never had a single CONFIRMED occurrence — same as
      // the full-cancel path (DELETE /recurring-bookings/:id), the rule
      // itself moves to CANCELLED rather than sitting ACTIVE with zero
      // bookings and no obvious way to tell it was rejected wholesale.
      if (claimed.count > 0 && booking.recurringRuleId) {
        await tx.recurringBookingRule.updateMany({ where: { id: booking.recurringRuleId, status: 'ACTIVE' }, data: { status: 'CANCELLED' } })
      }
      return claimed.count
    })
    if (claimedCount === 0) {
      return reply.status(409).send({ error: { message: 'Booking is not pending approval', code: 'BOOKING_NOT_PENDING' } })
    }

    // Re-derive from what the write actually claimed, not the pre-write
    // `affected` snapshot — same reasoning as approve above, but more
    // important here: releaseRejectedSlot calls promoteNextQueueEntry with
    // no idempotency guard, so re-running it for an occurrence that was
    // actually cancelled by something else (an individual withdrawal via
    // DELETE /:id, which is not recurringRuleId-scoped and can race a
    // series-wide reject) would promote a SECOND, different queue entrant
    // for a slot that was already freed and promoted once — a false "you
    // got the desk" notification for a slot that isn't really newly
    // available. `approvedByUserId: request.user.id` is a safe marker: a
    // withdrawal never sets it, and the auto-reject cron always leaves it
    // null (it has no acting user), so only rows THIS call actually
    // rejected match both conditions.
    const actuallyRejected = await prisma.booking.findMany({
      where: { id: { in: affected.map((b) => b.id) }, status: 'CANCELLED', approvedByUserId: request.user.id },
      select: { id: true, assetId: true, startsAt: true, endsAt: true },
      orderBy: { startsAt: 'asc' },
    })

    for (const b of actuallyRejected) {
      dispatchWebhook('booking.cancelled', { id: b.id, userId: booking.userId, assetId: b.assetId }).catch(() => {})
      await releaseRejectedSlot(b.assetId, b.startsAt, b.endsAt, booking.userId)
    }
    await enqueueNotification({
      type: NotificationType.BOOKING_REJECTED,
      userId: booking.userId,
      bookingId: actuallyRejected[0].id,
    })

    await recordAuditLog(prisma, {
      actorId: request.user.id,
      action: 'booking.rejected',
      resourceType: 'Booking',
      resourceId: id,
      before: { status: 'PENDING_APPROVAL' },
      after: { status: 'CANCELLED', rejectedCount: claimedCount, rejectionNote: note },
      ipAddress: request.ip,
    }, request.log)

    return reply.status(200).send({ data: { ok: true, rejectedCount: claimedCount } })
  })

  await bookingTransfersRoutes(fastify)

  await bookingSwapsRoutes(fastify)


}
