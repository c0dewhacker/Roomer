import type { FastifyInstance } from 'fastify'
import { prisma } from '../lib/prisma.js'
import { GlobalRole, NotificationType } from '@roomer/shared'
import { requireAuth } from '../middleware/requireAuth.js'
import { z } from 'zod'
import { enqueueNotification, promoteNextQueueEntry, fanOutFloorAvailable } from '../lib/queue.js'
import { dispatchWebhook } from '../lib/webhook.js'
import { assertBookable, isWithinAdvanceBookingWindow, lockAssetForBooking, lockUserForBookingQuota, checkZoneGroupOverlap, isOverlapConstraintViolation, resolveRequiresApproval } from '../lib/booking.js'
import { resolveBuildingTimezone, zonedWallClockToUtc } from '../lib/timezone.js'
import { getBuildingAdminUserIds, getFloorManagerUserIds } from '../middleware/requireRole.js'
import { recordAuditLog } from '../lib/audit.js'

const createRecurringSchema = z.object({
  assetId: z.string().min(1),
  frequency: z.enum(['DAILY', 'WEEKLY', 'MONTHLY']).default('WEEKLY'),
  dayOfWeek: z.number().int().min(0).max(6).optional(),
  startTime: z.string().regex(/^\d{2}:\d{2}$/, 'startTime must be HH:MM'),
  endTime: z.string().regex(/^\d{2}:\d{2}$/, 'endTime must be HH:MM'),
  firstDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'firstDate must be YYYY-MM-DD'),
  lastDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'lastDate must be YYYY-MM-DD'),
  attendeeCount: z.number().int().positive().max(1000).optional(),
}).refine(
  (d) => d.frequency !== 'WEEKLY' || d.dayOfWeek !== undefined,
  { message: 'dayOfWeek is required for weekly recurrence', path: ['dayOfWeek'] },
)

function parseTimeToMinutes(time: string): number {
  const [h, m] = time.split(':').map(Number)
  return h * 60 + m
}

/**
 * Combines a calendar date with a wall-clock HH:MM time, interpreted as
 * local time in `timeZone` (the asset's building — see #72), into the
 * correct UTC instant. DST-aware: "9am every Monday" stays 9am local
 * through a DST transition (the UTC instant shifts), matching how a real
 * recurring meeting behaves — not a fixed UTC offset baked in once.
 *
 * `dateUtcMidnight` only ever carries calendar-date information (see
 * getOccurrenceDates) — its UTC getters are used purely to read back
 * year/month/day, never as a real instant.
 */
function buildSlotDatetime(dateUtcMidnight: Date, timeHHMM: string, timeZone: string): Date {
  const [h, m] = timeHHMM.split(':').map(Number)
  return zonedWallClockToUtc(dateUtcMidnight.getUTCFullYear(), dateUtcMidnight.getUTCMonth() + 1, dateUtcMidnight.getUTCDate(), h, m, timeZone)
}

function getOccurrenceDates(
  frequency: 'DAILY' | 'WEEKLY' | 'MONTHLY',
  dayOfWeek: number | undefined,
  firstDate: string,
  lastDate: string,
): Date[] {
  const start = new Date(firstDate + 'T00:00:00.000Z')
  const end = new Date(lastDate + 'T00:00:00.000Z')
  const dates: Date[] = []
  const cursor = new Date(start)

  if (frequency === 'DAILY') {
    while (cursor <= end) {
      dates.push(new Date(cursor))
      cursor.setUTCDate(cursor.getUTCDate() + 1)
    }
  } else if (frequency === 'WEEKLY') {
    while (cursor.getUTCDay() !== dayOfWeek!) {
      cursor.setUTCDate(cursor.getUTCDate() + 1)
    }
    while (cursor <= end) {
      dates.push(new Date(cursor))
      cursor.setUTCDate(cursor.getUTCDate() + 7)
    }
  } else {
    // MONTHLY — repeat on the same day-of-month; clamp to last day when month is shorter
    const targetDay = start.getUTCDate()
    while (cursor <= end) {
      dates.push(new Date(cursor))
      const nextMonth = (cursor.getUTCMonth() + 1) % 12
      const nextYear = cursor.getUTCMonth() === 11 ? cursor.getUTCFullYear() + 1 : cursor.getUTCFullYear()
      const daysInNextMonth = new Date(Date.UTC(nextYear, nextMonth + 1, 0)).getUTCDate()
      cursor.setUTCFullYear(nextYear, nextMonth, Math.min(targetDay, daysInNextMonth))
    }
  }

  return dates
}

export async function recurringBookingRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.addHook('onRoute', (route) => { route.schema = { tags: ['Recurring Bookings'], ...route.schema } })

  // POST /recurring-bookings — create rule + materialise all bookings
  fastify.post('/', { preHandler: [requireAuth] }, async (request, reply) => {
    const result = createRecurringSchema.safeParse(request.body)
    if (!result.success) {
      return reply.status(400).send({
        error: { message: 'Validation failed', code: 'VALIDATION_ERROR', details: result.error.flatten() },
      })
    }

    const { assetId, frequency, dayOfWeek, startTime, endTime, firstDate, lastDate, attendeeCount } = result.data

    if (parseTimeToMinutes(startTime) >= parseTimeToMinutes(endTime)) {
      return reply.status(400).send({ error: { message: 'startTime must be before endTime', code: 'VALIDATION_ERROR' } })
    }

    const today = new Date()
    today.setUTCHours(0, 0, 0, 0)
    const firstDateObj = new Date(firstDate + 'T00:00:00.000Z')
    const lastDateObj = new Date(lastDate + 'T00:00:00.000Z')

    if (firstDateObj < today) {
      return reply.status(400).send({ error: { message: 'firstDate must be today or in the future', code: 'VALIDATION_ERROR' } })
    }
    if (lastDateObj < firstDateObj) {
      return reply.status(400).send({ error: { message: 'lastDate must be on or after firstDate', code: 'VALIDATION_ERROR' } })
    }

    const org = await prisma.organisation.findFirst({
      select: { maxRecurringBookingWeeks: true, maxAdvanceBookingDays: true },
    })
    const maxWeeks = org?.maxRecurringBookingWeeks ?? 12
    const spanMs = lastDateObj.getTime() - firstDateObj.getTime()
    const spanWeeks = spanMs / (7 * 24 * 60 * 60 * 1000)
    if (spanWeeks > maxWeeks) {
      return reply.status(400).send({
        error: { message: `Recurring booking span cannot exceed ${maxWeeks} weeks`, code: 'MAX_RECURRENCE_EXCEEDED' },
      })
    }

    // Advance-booking cap applies to when the series may *start* — not to every
    // occurrence within it, which would make a normal multi-week series (already
    // bounded by maxRecurringBookingWeeks above) impossible under most org configs.
    if (request.user.globalRole !== GlobalRole.SUPER_ADMIN && !isWithinAdvanceBookingWindow(firstDateObj, org?.maxAdvanceBookingDays)) {
      return reply.status(400).send({
        error: { message: `Recurring bookings cannot start more than ${org?.maxAdvanceBookingDays} days in advance`, code: 'MAX_ADVANCE_EXCEEDED' },
      })
    }

    const occurrenceDates = getOccurrenceDates(frequency, dayOfWeek, firstDate, lastDate)
    if (occurrenceDates.length === 0) {
      return reply.status(400).send({ error: { message: 'No occurrences found for the given day and date range', code: 'NO_OCCURRENCES' } })
    }

    // startTime/endTime are wall-clock in the asset's building's timezone
    // (see #72), not UTC — resolved once per series, not per occurrence,
    // since a series is scoped to a single asset/building throughout.
    const assetForTz = await prisma.asset.findUnique({ where: { id: assetId }, select: { floor: { select: { buildingId: true } } } })
    const timeZone = await resolveBuildingTimezone(prisma, assetForTz?.floor?.buildingId)

    const slots = occurrenceDates.map((d) => ({
      startsAt: buildSlotDatetime(d, startTime, timeZone),
      endsAt: buildSlotDatetime(d, endTime, timeZone),
    }))

    // Centralised bookability gate (bookable / disabled / restricted / assigned / group access),
    // checked once per occurrence rather than once across the whole first-to-last
    // span. The ASSIGNED-status branch of assertBookable checks every UTC calendar
    // day in the given range against the owner's allowed-weekday rules — spanning
    // the whole series would require every day between occurrences (weekends,
    // the other six days of each week) to also be marked available, incorrectly
    // rejecting an ordinary "book my colleague's Monday-available desk every
    // Monday" series that only ever touches Mondays.
    for (const slot of slots) {
      const gate = await assertBookable(prisma, request.user, assetId, slot.startsAt, slot.endsAt)
      if (!gate.ok) {
        return reply.status(gate.status).send({ error: { message: gate.message, code: gate.code } })
      }
    }

    // Asset-scoped (not per-occurrence) — a series is one approval decision,
    // not one per occurrence, so there's exactly one flag to resolve here.
    const requiresApproval = await resolveRequiresApproval(prisma, assetId)
    const approvalWindowHours = requiresApproval
      ? (await prisma.organisation.findFirst({ select: { approvalWindowHours: true } }))?.approvalWindowHours ?? 24
      : 0
    const approvalExpiresAt = requiresApproval ? new Date(Date.now() + approvalWindowHours * 60 * 60 * 1000) : null

    try {
      const rule = await prisma.$transaction(async (tx) => {
        // Serialise booking creation for this asset against all other paths
        await lockAssetForBooking(tx, assetId)
        // ZoneGroup conflicts are scoped per-user (see checkZoneGroupOverlap),
        // not per-asset, so they also need the per-user lock every other
        // zone-group-checking path uses to actually serialise against a
        // concurrent booking/reschedule by this same user in the same group.
        await lockUserForBookingQuota(tx, request.user.id)

        // Check all slots for conflicts atomically
        for (const slot of slots) {
          const conflict = await tx.booking.findFirst({
            where: {
              assetId,
              status: { in: ['CONFIRMED', 'PENDING_APPROVAL'] },
              startsAt: { lt: slot.endsAt },
              endsAt: { gt: slot.startsAt },
            },
            select: { id: true, startsAt: true },
          })
          if (conflict) {
            throw Object.assign(new Error('CONFLICT'), {
              code: 'BOOKING_CONFLICT',
              conflictAt: conflict.startsAt.toISOString().split('T')[0],
            })
          }
          // A recurring series is exempt from booking-quota enforcement (it
          // materialises every occurrence up front, which the quota isn't
          // meant to cap), but not from the zone-group rule — a weekly series
          // in Zone A still shouldn't coexist with the user's own booking in
          // Zone B of the same group on an overlapping occurrence.
          if (await checkZoneGroupOverlap(tx, request.user.id, assetId, slot.startsAt, slot.endsAt)) {
            throw Object.assign(new Error('CONFLICT'), {
              code: 'ZONE_GROUP_CONFLICT',
              conflictAt: slot.startsAt.toISOString().split('T')[0],
            })
          }
        }

        const createdRule = await tx.recurringBookingRule.create({
          data: {
            userId: request.user.id,
            assetId,
            frequency,
            dayOfWeek: dayOfWeek ?? null,
            startTime,
            endTime,
            firstDate: firstDateObj,
            lastDate: lastDateObj,
            bookings: {
              create: slots.map((s) => ({
                userId: request.user.id,
                assetId,
                startsAt: s.startsAt,
                endsAt: s.endsAt,
                status: requiresApproval ? 'PENDING_APPROVAL' : 'CONFIRMED',
                approvalExpiresAt,
                attendeeCount,
              })),
            },
          },
          include: {
            // Explicit order, not relying on nested-create return order — the
            // occurrence that actually gets the ICS invite below must be the
            // chronologically earliest one, deterministically.
            bookings: { select: { id: true, startsAt: true, endsAt: true, status: true }, orderBy: { startsAt: 'asc' } },
            asset: {
              select: {
                id: true, name: true,
                floor: { select: { id: true, buildingId: true, name: true, building: { select: { name: true } } } },
              },
            },
          },
        })

        // Recorded once, now, while "the earliest occurrence" is unambiguous
        // — see the matching comment on firstInvitedBookingId in schema.prisma
        // and its use in DELETE /:id below.
        await tx.recurringBookingRule.update({
          where: { id: createdRule.id },
          data: { firstInvitedBookingId: createdRule.bookings[0].id },
        })

        // createdRule is a snapshot from before the update above — patch the
        // field in manually rather than re-querying, so the response reflects
        // what's actually in the DB now.
        return { ...createdRule, firstInvitedBookingId: createdRule.bookings[0].id }
      })

      if (requiresApproval) {
        // One BOOKING_PENDING_APPROVAL per approver, referencing the first
        // occurrence — mirrors the single-booking POST /bookings gate.
        // Approving/rejecting acts on the whole rule at once (see POST
        // /bookings/:id/approve|reject), so no BOOKING_CONFIRMED or
        // booking.created fires until that happens.
        const floorId = rule.asset.floor?.id
        const buildingId = rule.asset.floor?.buildingId
        const [superAdmins, buildingAdminIds, floorManagerIds] = await Promise.all([
          prisma.user.findMany({ where: { globalRole: 'SUPER_ADMIN', accountStatus: 'ACTIVE' }, select: { id: true } }),
          buildingId ? getBuildingAdminUserIds(buildingId) : Promise.resolve([]),
          floorId ? getFloorManagerUserIds(floorId) : Promise.resolve([]),
        ])
        const approverIds = [...new Set([...superAdmins.map((a) => a.id), ...buildingAdminIds, ...floorManagerIds])]
          .filter((uid) => uid !== request.user.id)
        for (const userId of approverIds) {
          await enqueueNotification({
            type: NotificationType.BOOKING_PENDING_APPROVAL,
            userId,
            bookingId: rule.bookings[0].id,
          })
        }
      } else {
        // Single confirmation notification for the first booking in the series
        await enqueueNotification({
          type: NotificationType.BOOKING_CONFIRMED,
          userId: request.user.id,
          bookingId: rule.bookings[0].id,
        })

        // One booking.created per materialised occurrence — same event a direct
        // POST /bookings fires, unlike the notification above (deliberately
        // deduplicated to one per series so the user isn't emailed N times).
        // An integration reconciling desk occupancy off booking.created
        // previously never learned about any recurring booking at all.
        for (const b of rule.bookings) {
          dispatchWebhook('booking.created', { id: b.id, userId: request.user.id, assetId, startsAt: b.startsAt, endsAt: b.endsAt }).catch(() => {})
        }
      }

      // One summary row for the whole series, not one per materialised
      // occurrence — a series is one booking decision (see the approval
      // notification logic above, which applies the same reasoning).
      await recordAuditLog(prisma, {
        actorId: request.user.id,
        action: 'recurring_booking_rule.created',
        resourceType: 'RecurringBookingRule',
        resourceId: rule.id,
        after: { assetId, frequency, firstDate, lastDate, occurrenceCount: rule.bookings.length, requiresApproval },
        ipAddress: request.ip,
      }, request.log)

      return reply.status(201).send({ data: rule })
    } catch (err: unknown) {
      const e = err as { code?: string; conflictAt?: string }
      if (e.code === 'BOOKING_CONFLICT') {
        return reply.status(409).send({
          error: {
            message: `Booking conflict on ${e.conflictAt} — the entire series was not created`,
            code: 'BOOKING_CONFLICT',
          },
        })
      }
      if (e.code === 'ZONE_GROUP_CONFLICT') {
        return reply.status(409).send({
          error: {
            message: `You already have a booking in the same zone group on ${e.conflictAt} — the entire series was not created`,
            code: 'ZONE_GROUP_CONFLICT',
          },
        })
      }
      // Database-level backstop: the booking_no_overlap exclusion constraint
      if (isOverlapConstraintViolation(err)) {
        return reply.status(409).send({
          error: { message: 'One or more occurrences conflict with an existing booking — the series was not created', code: 'BOOKING_CONFLICT' },
        })
      }
      throw err
    }
  })

  // GET /recurring-bookings — list current user's rules
  fastify.get('/', { preHandler: [requireAuth] }, async (request, reply) => {
    const rules = await prisma.recurringBookingRule.findMany({
      where: { userId: request.user.id },
      include: {
        asset: { select: { id: true, name: true, bookingLabel: true, floor: { select: { name: true, building: { select: { name: true } } } } } },
        bookings: {
          where: { status: { in: ['CONFIRMED', 'PENDING_APPROVAL'] }, startsAt: { gte: new Date() } },
          select: { id: true, startsAt: true, endsAt: true, status: true },
          orderBy: { startsAt: 'asc' },
        },
        _count: { select: { bookings: true } },
      },
      orderBy: { createdAt: 'desc' },
    })
    return reply.status(200).send({ data: rules })
  })

  // GET /recurring-bookings/:id — get rule with all bookings
  fastify.get('/:id', { preHandler: [requireAuth] }, async (request, reply) => {
    const { id } = request.params as { id: string }
    const rule = await prisma.recurringBookingRule.findUnique({
      where: { id },
      include: {
        asset: { select: { id: true, name: true, bookingLabel: true, floor: { select: { name: true, building: { select: { name: true } } } } } },
        bookings: {
          select: { id: true, startsAt: true, endsAt: true, status: true },
          orderBy: { startsAt: 'asc' },
        },
      },
    })
    if (!rule) return reply.status(404).send({ error: { message: 'Rule not found', code: 'NOT_FOUND' } })
    if (rule.userId !== request.user.id && request.user.globalRole !== GlobalRole.SUPER_ADMIN) {
      return reply.status(403).send({ error: { message: 'Insufficient permissions', code: 'FORBIDDEN' } })
    }
    return reply.status(200).send({ data: rule })
  })

  // PATCH /recurring-bookings/:id — extend or shorten the series end date.
  // Deliberately scoped to lastDate only (not frequency/dayOfWeek/time/
  // firstDate) — changing the recurrence pattern itself would mean
  // cancelling and regenerating every future occurrence anyway, which is
  // already achievable via DELETE + POST. Extending or shortening the tail
  // of an otherwise-unchanged series is the one case that's meaningfully
  // better done in place: it preserves every occurrence already booked
  // (and any queue/notification history tied to them) instead of starting
  // over. See #227 — "pause" (skip individual dates) was deliberately not
  // built as a separate mechanism: cancelling a single occurrence already
  // works today via DELETE /bookings/:id like any other booking, since
  // that route has no special-casing for recurringRuleId.
  const updateRecurringSchema = z.object({
    lastDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'lastDate must be YYYY-MM-DD'),
  })

  fastify.patch('/:id', { preHandler: [requireAuth] }, async (request, reply) => {
    const { id } = request.params as { id: string }
    const result = updateRecurringSchema.safeParse(request.body)
    if (!result.success) {
      return reply.status(400).send({
        error: { message: 'Validation failed', code: 'VALIDATION_ERROR', details: result.error.flatten() },
      })
    }

    const rule = await prisma.recurringBookingRule.findUnique({ where: { id } })
    if (!rule) return reply.status(404).send({ error: { message: 'Rule not found', code: 'NOT_FOUND' } })
    if (rule.userId !== request.user.id && request.user.globalRole !== GlobalRole.SUPER_ADMIN) {
      return reply.status(403).send({ error: { message: 'Insufficient permissions', code: 'FORBIDDEN' } })
    }
    if (rule.status === 'CANCELLED') {
      return reply.status(409).send({ error: { message: 'Rule is already cancelled', code: 'ALREADY_CANCELLED' } })
    }

    const newLastDateObj = new Date(result.data.lastDate + 'T00:00:00.000Z')
    if (newLastDateObj < rule.firstDate) {
      return reply.status(400).send({ error: { message: 'lastDate must be on or after the series start date', code: 'VALIDATION_ERROR' } })
    }

    const org = await prisma.organisation.findFirst({ select: { maxRecurringBookingWeeks: true } })
    const maxWeeks = org?.maxRecurringBookingWeeks ?? 12
    const spanWeeks = (newLastDateObj.getTime() - rule.firstDate.getTime()) / (7 * 24 * 60 * 60 * 1000)
    if (spanWeeks > maxWeeks) {
      return reply.status(400).send({
        error: { message: `Recurring booking span cannot exceed ${maxWeeks} weeks`, code: 'MAX_RECURRENCE_EXCEEDED' },
      })
    }

    // frequency/dayOfWeek/firstDate are immutable via this endpoint (schema
    // only accepts lastDate), so it's safe to compute this off the outer,
    // possibly-stale `rule` — unlike lastDate itself, they can't have
    // changed underneath us. Catches shortening to a date that eliminates
    // every real occurrence (e.g. a WEEKLY Wednesday series whose firstDate
    // is a Monday — the first actual occurrence lands 2 days later, so a
    // naive "lastDate >= firstDate" check alone lets a shorten past that
    // point leave the rule ACTIVE with zero bookings and no way to tell).
    const firstDateStr = rule.firstDate.toISOString().slice(0, 10)
    const remainingOccurrences = getOccurrenceDates(rule.frequency, rule.dayOfWeek ?? undefined, firstDateStr, result.data.lastDate)
    if (remainingOccurrences.length === 0) {
      return reply.status(400).send({
        error: { message: 'No occurrences would remain with this end date — cancel the series instead', code: 'NO_OCCURRENCES' },
      })
    }

    // Everything below reads and writes rule.lastDate. A second PATCH on this
    // same rule (e.g. a concurrent extend racing this shorten) could read its
    // own stale copy of lastDate between our read above and now, and the two
    // requests' writes would then race — whichever commits last silently
    // overwrites the other's lastDate while both sets of booking-row changes
    // persist, leaving the rule's lastDate inconsistent with its actual
    // bookings (see #228-adjacent recurring-extend audit). Hold the same
    // per-asset advisory lock booking creation already uses so a second PATCH
    // on this rule's asset can't interleave, then re-read the rule inside the
    // lock and redo every lastDate-dependent decision against that fresh copy.
    try {
      const outcome = await prisma.$transaction(async (tx) => {
        await lockAssetForBooking(tx, rule.assetId)

        const freshRule = await tx.recurringBookingRule.findUnique({ where: { id } })
        if (!freshRule || freshRule.status === 'CANCELLED') {
          throw Object.assign(new Error('RULE_GONE'), { code: 'RULE_GONE' })
        }
        if (result.data.lastDate === freshRule.lastDate.toISOString().slice(0, 10)) {
          throw Object.assign(new Error('NO_CHANGE'), { code: 'NO_CHANGE' })
        }

        if (newLastDateObj > freshRule.lastDate) {
          // Extending — generate only the newly-covered occurrences relative
          // to the fresh lastDate (everything up to it already exists).
          const allDates = getOccurrenceDates(freshRule.frequency, freshRule.dayOfWeek ?? undefined, firstDateStr, result.data.lastDate)
          const newDates = allDates.filter((d) => d > freshRule.lastDate)
          if (newDates.length === 0) {
            throw Object.assign(new Error('NO_OCCURRENCES'), { code: 'NO_OCCURRENCES' })
          }
          const extendAsset = await tx.asset.findUnique({ where: { id: freshRule.assetId }, select: { floor: { select: { buildingId: true } } } })
          const extendTimeZone = await resolveBuildingTimezone(tx, extendAsset?.floor?.buildingId)
          const slots = newDates.map((d) => ({
            startsAt: buildSlotDatetime(d, freshRule.startTime, extendTimeZone),
            endsAt: buildSlotDatetime(d, freshRule.endTime, extendTimeZone),
          }))

          // Same gate as creation (line ~170) — an extension re-materialises
          // occurrences against the asset's CURRENT approval requirement, not
          // whatever was true when the series was first created, so this has
          // to be re-resolved here rather than carried over from the rule.
          const requiresApproval = await resolveRequiresApproval(tx, freshRule.assetId)
          const approvalWindowHours = requiresApproval
            ? (await tx.organisation.findFirst({ select: { approvalWindowHours: true } }))?.approvalWindowHours ?? 24
            : 0
          const approvalExpiresAt = requiresApproval ? new Date(Date.now() + approvalWindowHours * 60 * 60 * 1000) : null

          // Same centralised gate as creation, checked per-occurrence for the
          // same reason (an ASSIGNED-desk allowed-weekday check spanning the
          // whole range would incorrectly require every day between occurrences
          // to also be available).
          for (const slot of slots) {
            const gate = await assertBookable(tx, request.user, freshRule.assetId, slot.startsAt, slot.endsAt)
            if (!gate.ok) {
              throw Object.assign(new Error('NOT_BOOKABLE'), { code: gate.code, status: gate.status, message: gate.message })
            }
          }

          // ZoneGroup conflicts are scoped per-user, not per-asset (see
          // checkZoneGroupOverlap), so they need this lock — the per-asset
          // one above doesn't serialise them against a concurrent booking by
          // this same user in another zone of the same group.
          await lockUserForBookingQuota(tx, freshRule.userId)

          for (const slot of slots) {
            const conflict = await tx.booking.findFirst({
              where: {
                assetId: freshRule.assetId,
                status: { in: ['CONFIRMED', 'PENDING_APPROVAL'] },
                startsAt: { lt: slot.endsAt },
                endsAt: { gt: slot.startsAt },
              },
              select: { id: true, startsAt: true },
            })
            if (conflict) {
              throw Object.assign(new Error('CONFLICT'), {
                code: 'BOOKING_CONFLICT',
                conflictAt: conflict.startsAt.toISOString().split('T')[0],
              })
            }
            if (await checkZoneGroupOverlap(tx, freshRule.userId, freshRule.assetId, slot.startsAt, slot.endsAt)) {
              throw Object.assign(new Error('CONFLICT'), {
                code: 'ZONE_GROUP_CONFLICT',
                conflictAt: slot.startsAt.toISOString().split('T')[0],
              })
            }
          }

          const updated = await tx.recurringBookingRule.update({
            where: { id },
            data: {
              lastDate: newLastDateObj,
              bookings: {
                create: slots.map((s) => ({
                  userId: freshRule.userId,
                  assetId: freshRule.assetId,
                  startsAt: s.startsAt,
                  endsAt: s.endsAt,
                  status: requiresApproval ? 'PENDING_APPROVAL' : 'CONFIRMED',
                  approvalExpiresAt,
                })),
              },
            },
            include: {
              bookings: { select: { id: true, startsAt: true, endsAt: true, status: true }, orderBy: { startsAt: 'asc' } },
              asset: {
                select: {
                  id: true, name: true,
                  floor: { select: { id: true, buildingId: true, name: true, building: { select: { name: true } } } },
                },
              },
            },
          })
          // Identify exactly the occurrences this call just created (by the
          // startsAt values computed above, before the update) so the caller
          // can notify/webhook only the new ones, not the whole series.
          const newStartsAtMs = new Set(slots.map((s) => s.startsAt.getTime()))
          const newlyCreated = updated.bookings.filter((b) => newStartsAtMs.has(b.startsAt.getTime()))
          return { kind: 'extend' as const, rule: updated, newlyCreated, requiresApproval }
        }

        // Shortening — cancel occurrences that now fall after the new end date.
        const newLastDateEndOfDay = new Date(newLastDateObj)
        newLastDateEndOfDay.setUTCHours(23, 59, 59, 999)
        const droppedBookings = await tx.booking.findMany({
          where: { recurringRuleId: id, status: 'CONFIRMED', startsAt: { gt: newLastDateEndOfDay } },
          select: { id: true, assetId: true, startsAt: true, endsAt: true },
        })
        await tx.booking.updateMany({
          where: { id: { in: droppedBookings.map((b) => b.id) } },
          data: { status: 'CANCELLED' },
        })
        const updated = await tx.recurringBookingRule.update({
          where: { id },
          data: { lastDate: newLastDateObj },
          include: {
            bookings: { select: { id: true, startsAt: true, endsAt: true, status: true }, orderBy: { startsAt: 'asc' } },
            asset: { select: { id: true, name: true, floor: { select: { name: true, building: { select: { name: true } } } } } },
          },
        })
        return { kind: 'shorten' as const, rule: updated, droppedBookings }
      })

      if (outcome.kind === 'extend') {
        // Same shape as series creation: one confirmation notification for
        // the operation, plus a booking.created webhook per newly-materialised
        // occurrence (not per creation call) — this branch didn't exist at
        // all previously, so extending a series created real CONFIRMED
        // bookings with no notification and no webhook for any of them.
        if (outcome.newlyCreated.length > 0) {
          if (outcome.requiresApproval) {
            // Mirrors series creation's approver fan-out (line ~266) — an
            // extension re-resolves and can newly require approval even for
            // a series that was originally CONFIRMED-only, so the newly
            // created occurrences must go through the same queue, not
            // straight to BOOKING_CONFIRMED + webhook.
            const floorId = outcome.rule.asset.floor?.id
            const buildingId = outcome.rule.asset.floor?.buildingId
            const [superAdmins, buildingAdminIds, floorManagerIds] = await Promise.all([
              prisma.user.findMany({ where: { globalRole: 'SUPER_ADMIN', accountStatus: 'ACTIVE' }, select: { id: true } }),
              buildingId ? getBuildingAdminUserIds(buildingId) : Promise.resolve([]),
              floorId ? getFloorManagerUserIds(floorId) : Promise.resolve([]),
            ])
            const approverIds = [...new Set([...superAdmins.map((a) => a.id), ...buildingAdminIds, ...floorManagerIds])]
              .filter((uid) => uid !== request.user.id)
            for (const userId of approverIds) {
              await enqueueNotification({
                type: NotificationType.BOOKING_PENDING_APPROVAL,
                userId,
                bookingId: outcome.newlyCreated[0].id,
              })
            }
          } else {
            await enqueueNotification({
              type: NotificationType.BOOKING_CONFIRMED,
              userId: rule.userId,
              bookingId: outcome.newlyCreated[0].id,
            })
            for (const b of outcome.newlyCreated) {
              dispatchWebhook('booking.created', { id: b.id, userId: rule.userId, assetId: rule.assetId, startsAt: b.startsAt, endsAt: b.endsAt }).catch(() => {})
            }
          }
        }
      } else if (outcome.kind === 'shorten') {
        // A recurring rule is always for a single asset, so this is fetched
        // once rather than per dropped occurrence. Only used in the "nobody
        // was queued" branch below — same fan-out a single ad-hoc booking
        // cancellation does (bookings.ts DELETE /:id), which this series-cancel
        // path previously skipped entirely, so floor subscribers never heard
        // about a slot freed by shortening or cancelling a recurring series.
        const droppedAsset = outcome.droppedBookings.length > 0
          ? await prisma.asset.findUnique({ where: { id: rule.assetId }, select: { floorId: true, primaryZoneId: true } })
          : null

        for (const b of outcome.droppedBookings) {
          dispatchWebhook('booking.cancelled', { id: b.id, userId: rule.userId, assetId: b.assetId }).catch(() => {})
          const nextQueued = await promoteNextQueueEntry(b.assetId, b.startsAt, b.endsAt)
          if (nextQueued) {
            await enqueueNotification({
              type: NotificationType.QUEUE_PROMOTED,
              userId: nextQueued.userId,
              queueEntryId: nextQueued.id,
              claimDeadline: nextQueued.claimDeadline.toISOString(),
            })
            dispatchWebhook('queue.promoted', { id: nextQueued.id, userId: nextQueued.userId, assetId: nextQueued.assetId, claimDeadline: nextQueued.claimDeadline.toISOString() }).catch(() => {})
          } else if (droppedAsset?.floorId) {
            const slotDate = b.startsAt.toISOString().slice(0, 10)
            await fanOutFloorAvailable(b.assetId, droppedAsset.floorId, droppedAsset.primaryZoneId, slotDate, rule.userId).catch(() => {})
          }
        }

        // One notification, not one per dropped occurrence — same reasoning as
        // full cancellation below. The ICS CANCEL is normally a no-op (only
        // the series' very first occurrence ever got an actual REQUEST
        // invite, and shortening only drops LATER dates, which never had one
        // to begin with) — except when that first occurrence was itself
        // individually rescheduled past the new cutoff (PATCH /bookings/:id
        // has no recurring-series special-casing), in which case it IS among
        // the dropped set and genuinely does have a live invite to cancel.
        // Prefer it explicitly rather than an arbitrary dropped booking (the
        // query has no orderBy) so that case gets a real CANCEL instead of a
        // moot one referencing the wrong UID.
        if (outcome.droppedBookings.length > 0) {
          const isSelf = rule.userId === request.user.id
          const invitedDrop = outcome.droppedBookings.find((b) => b.id === rule.firstInvitedBookingId)
          await enqueueNotification({
            type: isSelf ? NotificationType.BOOKING_CANCELLED : NotificationType.BOOKING_CANCELLED_BY_ADMIN,
            userId: rule.userId,
            bookingId: (invitedDrop ?? outcome.droppedBookings[0]).id,
          })
        }
      }

      // One summary row per PATCH call, not one per occurrence created/cancelled.
      await recordAuditLog(prisma, {
        actorId: request.user.id,
        action: outcome.kind === 'extend' ? 'recurring_booking_rule.extended' : 'recurring_booking_rule.shortened',
        resourceType: 'RecurringBookingRule',
        resourceId: id,
        before: { lastDate: rule.lastDate },
        after: outcome.kind === 'extend'
          ? { lastDate: outcome.rule.lastDate, newOccurrenceCount: outcome.newlyCreated.length }
          : { lastDate: outcome.rule.lastDate, droppedOccurrenceCount: outcome.droppedBookings.length },
        ipAddress: request.ip,
      }, request.log)

      return reply.status(200).send({ data: outcome.rule })
    } catch (err: unknown) {
      const e = err as { code?: string; conflictAt?: string; status?: number; message?: string }
      if (e.code === 'NO_CHANGE') {
        return reply.status(400).send({ error: { message: 'lastDate is unchanged', code: 'NO_CHANGE' } })
      }
      if (e.code === 'RULE_GONE') {
        return reply.status(409).send({ error: { message: 'Rule was modified concurrently — please retry', code: 'CONFLICT' } })
      }
      if (e.code === 'NO_OCCURRENCES') {
        return reply.status(400).send({ error: { message: 'No new occurrences fall in the extended range', code: 'NO_OCCURRENCES' } })
      }
      if (e.code === 'BOOKING_CONFLICT') {
        return reply.status(409).send({
          error: { message: `Booking conflict on ${e.conflictAt} — the change was not applied`, code: 'BOOKING_CONFLICT' },
        })
      }
      if (e.code === 'ZONE_GROUP_CONFLICT') {
        return reply.status(409).send({
          error: { message: `You already have a booking in the same zone group on ${e.conflictAt} — the change was not applied`, code: 'ZONE_GROUP_CONFLICT' },
        })
      }
      if (e.code === 'NOT_BOOKABLE') {
        return reply.status(e.status ?? 400).send({ error: { message: e.message ?? 'Not bookable', code: 'NOT_BOOKABLE' } })
      }
      if (isOverlapConstraintViolation(err)) {
        return reply.status(409).send({
          error: { message: 'One or more new occurrences conflict with an existing booking — the change was not applied', code: 'BOOKING_CONFLICT' },
        })
      }
      throw err
    }
  })

  // DELETE /recurring-bookings/:id — cancel rule + all future bookings
  fastify.delete('/:id', { preHandler: [requireAuth] }, async (request, reply) => {
    const { id } = request.params as { id: string }
    const rule = await prisma.recurringBookingRule.findUnique({
      where: { id },
      select: { id: true, userId: true, status: true, assetId: true, firstInvitedBookingId: true },
    })
    if (!rule) return reply.status(404).send({ error: { message: 'Rule not found', code: 'NOT_FOUND' } })
    if (rule.userId !== request.user.id && request.user.globalRole !== GlobalRole.SUPER_ADMIN) {
      return reply.status(403).send({ error: { message: 'Insufficient permissions', code: 'FORBIDDEN' } })
    }
    if (rule.status === 'CANCELLED') {
      return reply.status(409).send({ error: { message: 'Rule is already cancelled', code: 'ALREADY_CANCELLED' } })
    }

    const now = new Date()
    // Capture the freed occurrences before cancelling — updateMany doesn't
    // return rows, and each one needs its own assetId/startsAt/endsAt to check
    // the queue for a waiting user, same as a single direct-booking cancellation
    // already does. Without this, cancelling a recurring series silently orphans
    // any queue entries waiting on those slots: the desk is free again but no
    // one ever gets promoted or notified.
    const futureBookings = await prisma.booking.findMany({
      where: { recurringRuleId: id, status: 'CONFIRMED', startsAt: { gt: now } },
      select: { id: true, assetId: true, startsAt: true, endsAt: true },
    })

    // The series' very first occurrence is the only one that ever got an actual
    // ICS invite emailed (see POST / above: "Single confirmation notification
    // for the first booking in the series") — the rest were never added to the
    // recipient's calendar via ICS at all. So that first occurrence's booking id
    // is the one whose UID needs a matching CANCEL for the calendar app to
    // remove/void the invite it's actually holding; it's independent of
    // futureBookings, which only tracks occurrences still ahead of "now".
    //
    // Looked up via the id recorded at creation (rule.firstInvitedBookingId),
    // not by re-deriving "earliest startsAt" now — an individual occurrence
    // can be rescheduled (PATCH /bookings/:id has no recurring-series
    // special-casing) to a date after its siblings, which would silently
    // point a by-date lookup at the wrong booking and send the CANCEL to a
    // UID the recipient's calendar has never seen, leaving the one they
    // actually have permanently stuck as "confirmed". Falls back to the old
    // by-date heuristic only for rules created before this field existed.
    const firstOccurrence = rule.firstInvitedBookingId
      ? { id: rule.firstInvitedBookingId }
      : await prisma.booking.findFirst({
          where: { recurringRuleId: id },
          orderBy: { startsAt: 'asc' },
          select: { id: true },
        })

    await prisma.$transaction([
      prisma.booking.updateMany({
        where: { id: { in: futureBookings.map((b) => b.id) } },
        data: { status: 'CANCELLED' },
      }),
      prisma.recurringBookingRule.update({
        where: { id },
        data: { status: 'CANCELLED' },
      }),
    ])
    // One summary row for the whole cancellation, not one per cancelled occurrence.
    await recordAuditLog(prisma, {
      actorId: request.user.id,
      action: 'recurring_booking_rule.cancelled',
      resourceType: 'RecurringBookingRule',
      resourceId: id,
      before: { status: rule.status },
      after: { status: 'CANCELLED', cancelledOccurrenceCount: futureBookings.length },
      ipAddress: request.ip,
    }, request.log)

    // A recurring rule is always for a single asset — fetched once, only used
    // in the "nobody was queued" branch below. Same fan-out a single ad-hoc
    // booking cancellation does (bookings.ts DELETE /:id); this series-cancel
    // path previously never called it, so floor subscribers never heard about
    // a slot freed by cancelling a recurring series.
    const cancelledAsset = futureBookings.length > 0
      ? await prisma.asset.findUnique({ where: { id: rule.assetId }, select: { floorId: true, primaryZoneId: true } })
      : null

    for (const b of futureBookings) {
      dispatchWebhook('booking.cancelled', { id: b.id, userId: rule.userId, assetId: b.assetId }).catch(() => {})
      const nextQueued = await promoteNextQueueEntry(b.assetId, b.startsAt, b.endsAt)
      if (nextQueued) {
        await enqueueNotification({
          type: NotificationType.QUEUE_PROMOTED,
          userId: nextQueued.userId,
          queueEntryId: nextQueued.id,
          claimDeadline: nextQueued.claimDeadline.toISOString(),
        })
        dispatchWebhook('queue.promoted', { id: nextQueued.id, userId: nextQueued.userId, assetId: nextQueued.assetId, claimDeadline: nextQueued.claimDeadline.toISOString() }).catch(() => {})
      } else if (cancelledAsset?.floorId) {
        const slotDate = b.startsAt.toISOString().slice(0, 10)
        await fanOutFloorAvailable(b.assetId, cancelledAsset.floorId, cancelledAsset.primaryZoneId, slotDate, rule.userId).catch(() => {})
      }
    }

    // Notify the series owner once, same as a single-booking cancel — without
    // this, cancelling a whole series produced no email and no ICS CANCEL, so
    // the owner had no confirmation it worked and their calendar app kept
    // showing the original invite as still confirmed indefinitely.
    if (firstOccurrence) {
      const isSelf = rule.userId === request.user.id
      await enqueueNotification({
        type: isSelf ? NotificationType.BOOKING_CANCELLED : NotificationType.BOOKING_CANCELLED_BY_ADMIN,
        userId: rule.userId,
        bookingId: firstOccurrence.id,
      })
    }

    return reply.status(200).send({ data: { ok: true } })
  })
}
