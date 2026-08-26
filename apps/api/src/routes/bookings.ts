import type { FastifyInstance } from 'fastify'
import type { Prisma } from '@prisma/client'
import { randomUUID } from 'crypto'
import { env } from '../env.js'
import { prisma } from '../lib/prisma.js'
import { createBookingSchema, updateBookingSchema, GlobalRole, NotificationType } from '@roomer/shared'
import { requireAuth } from '../middleware/requireAuth.js'
import { isFloorManagerForFloor, isBuildingManagerForBuilding, getManagedBuildingIds, getManagedFloorIds, getBuildingAdminUserIds, getFloorManagerUserIds } from '../middleware/requireRole.js'
import { enqueueNotification, fanOutFloorAvailable, promoteNextQueueEntry } from '../lib/queue.js'
import { dispatchWebhook } from '../lib/webhook.js'
import { buildBookingIcs } from '../lib/ical.js'
import { sendEmail, renderGuestBookingInvite, renderGuestBookingCancelled } from '../lib/mailer.js'
import { checkGroupAccess } from './groups.js'
import { assertBookable, assertUnderBookingQuota, hasBlockingOverlap, checkZoneGroupOverlap, isWithinAdvanceBookingWindow, isNotAlreadyElapsed, lockAssetForBooking, lockUserForBookingQuota, isOverlapConstraintViolation, resolveRequiresApproval } from '../lib/booking.js'
import { resolveBuildingTimezone, localDateStr, zonedWallClockToUtc } from '../lib/timezone.js'
import { recordAuditLog } from '../lib/audit.js'
import { z } from 'zod'

class BookingConflictError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message)
    this.name = 'BookingConflictError'
  }
}

/**
 * Emails the guest a check-in link once their booking is actually CONFIRMED
 * (immediately on creation, or later via POST /:id/approve if the zone
 * requires approval) — sent directly via sendEmail rather than through
 * enqueueNotification/Notification, since a guest has no User row to key a
 * Notification on or an in-app bell to show it in.
 *
 * Includes an .ics REQUEST attachment, same as the host's own confirmation
 * email — a guest's "you're booked in" email is a confirmation email, and
 * without a calendar payload their calendar app never actually gets the
 * event. A reschedule resend reuses the same id/UID with the booking's
 * current (already-bumped) icsSequence, so the recipient's calendar app
 * recognises it as an update to the existing event rather than a duplicate.
 */
async function sendGuestBookingInvite(booking: {
  id: string
  startsAt: Date
  endsAt: Date
  guestName: string
  guestEmail: string
  guestCheckInToken: string
  icsSequence: number
}, hostDisplayName: string, asset: { name: string; primaryZone?: { name: string } | null; floor?: { name: string; building?: { name: string } | null } | null }, timeZone = 'UTC'): Promise<void> {
  const checkInUrl = `${env.APP_URL}/guest-check-in?token=${encodeURIComponent(booking.guestCheckInToken)}`
  const payload = renderGuestBookingInvite(
    booking.guestName,
    { displayName: hostDisplayName },
    booking,
    { name: asset.name, zoneName: asset.primaryZone?.name, floorName: asset.floor?.name, buildingName: asset.floor?.building?.name },
    checkInUrl,
    timeZone,
  )
  const icalEvent = {
    method: 'REQUEST',
    content: buildBookingIcs({
      id: booking.id, startsAt: booking.startsAt, endsAt: booking.endsAt,
      assetName: asset.name, zoneName: asset.primaryZone?.name, floorName: asset.floor?.name, buildingName: asset.floor?.building?.name,
      sequence: booking.icsSequence,
      attendeeEmail: booking.guestEmail, attendeeName: booking.guestName,
    }, 'REQUEST'),
  }
  await sendEmail({ to: booking.guestEmail, ...payload, icalEvent }).catch(() => {})
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
          // guestCheckInToken is a bare, unauthenticated credential (see
          // POST /guest-check-in-by-token) — it must never appear in a
          // response any admin/building-manager can read, only in the
          // invite email actually sent to the guest.
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

    const updated = await prisma.booking.update({ where: { id }, data: { checkedInAt: new Date() } })
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
    const updated = await prisma.booking.update({ where: { id: booking.id }, data: { checkedInAt: now } })
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

        return tx.booking.update({
          where: { id },
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
      where: { id, status: { in: ['CONFIRMED', 'PENDING_APPROVAL'] } },
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

    const now = new Date()
    const affected = booking.recurringRuleId
      ? await prisma.booking.findMany({
          where: { recurringRuleId: booking.recurringRuleId, status: 'PENDING_APPROVAL' },
          select: { id: true, assetId: true, startsAt: true, endsAt: true },
          orderBy: { startsAt: 'asc' },
        })
      : [{ id: booking.id, assetId: booking.assetId, startsAt: booking.startsAt, endsAt: booking.endsAt }]

    // Claimed atomically (status: 'PENDING_APPROVAL' guard), not an
    // unconditional update — otherwise this can race a concurrent reject (or
    // the auto-reject-pending-approvals cron) that read PENDING_APPROVAL
    // before either commits: whichever side's write lands last would
    // silently overwrite the other's status with no error, while BOTH
    // sides' webhooks/notifications/audit rows still fire — a booking that
    // ends up CANCELLED can still get a booking.created webhook and a
    // BOOKING_APPROVED email, or (worse) one that ends up CONFIRMED can
    // still have releaseRejectedSlot hand its still-occupied slot to the
    // next queued user, a real path to a double-booked desk.
    const claimed = await prisma.booking.updateMany({
      where: { id: { in: affected.map((b) => b.id) }, status: 'PENDING_APPROVAL' },
      data: { status: 'CONFIRMED', approvedAt: now, approvedByUserId: request.user.id, approvalExpiresAt: null },
    })
    if (claimed.count === 0) {
      return reply.status(409).send({ error: { message: 'Booking is not pending approval', code: 'BOOKING_NOT_PENDING' } })
    }

    for (const b of affected) {
      dispatchWebhook('booking.created', { id: b.id, userId: booking.userId, assetId: b.assetId, startsAt: b.startsAt, endsAt: b.endsAt }).catch(() => {})
    }
    // One notification for the whole approval decision, referencing the
    // earliest occurrence — same dedup reasoning as recurring creation's
    // single BOOKING_CONFIRMED (see POST /recurring-bookings).
    await enqueueNotification({
      type: NotificationType.BOOKING_APPROVED,
      userId: booking.userId,
      bookingId: affected[0].id,
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

    for (const b of affected) {
      dispatchWebhook('booking.cancelled', { id: b.id, userId: booking.userId, assetId: b.assetId }).catch(() => {})
      await releaseRejectedSlot(b.assetId, b.startsAt, b.endsAt, booking.userId)
    }
    await enqueueNotification({
      type: NotificationType.BOOKING_REJECTED,
      userId: booking.userId,
      bookingId: affected[0].id,
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
    const bookingSelect = { select: { id: true, startsAt: true, endsAt: true, asset: { select: { name: true } } } } as const
    const [sent, received] = await Promise.all([
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
    ])
    return reply.status(200).send({ data: { sent, received } })
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
        await tx.booking.update({
          where: { id: fresh.bookingId },
          data: { userId: request.user.id, icsSequence: { increment: 1 } },
        })
        await tx.bookingTransfer.update({
          where: { id },
          data: { status: 'ACCEPTED', respondedAt: new Date() },
        })
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
    await prisma.bookingTransfer.update({ where: { id }, data: { status: 'DECLINED', respondedAt: new Date() } })
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
    await prisma.bookingTransfer.update({ where: { id }, data: { status: 'CANCELLED', respondedAt: new Date() } })
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
      select: { id: true, startsAt: true, endsAt: true, asset: { select: { id: true, name: true } } },
    })
    return reply.status(200).send({ data: candidate })
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
    const bookingSelect = { select: { id: true, startsAt: true, endsAt: true, asset: { select: { name: true } } } } as const
    const [sent, received] = await Promise.all([
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
    ])
    return reply.status(200).send({ data: { sent, received } })
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

        await tx.booking.update({ where: { id: fresh.bookingAId }, data: { userId: fresh.recipientUserId, icsSequence: { increment: 1 } } })
        await tx.booking.update({ where: { id: fresh.bookingBId }, data: { userId: fresh.initiatorUserId, icsSequence: { increment: 1 } } })
        await tx.bookingSwap.update({ where: { id }, data: { status: 'ACCEPTED', respondedAt: new Date() } })
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
    await prisma.bookingSwap.update({ where: { id }, data: { status: 'DECLINED', respondedAt: new Date() } })
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
    await prisma.bookingSwap.update({ where: { id }, data: { status: 'CANCELLED', respondedAt: new Date() } })
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
