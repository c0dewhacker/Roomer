import type { FastifyInstance } from 'fastify'
import { prisma } from '../lib/prisma.js'
import { GlobalRole, NotificationType } from '@roomer/shared'
import { requireAuth } from '../middleware/requireAuth.js'
import { z } from 'zod'
import { enqueueNotification, promoteNextQueueEntry } from '../lib/queue.js'
import { dispatchWebhook } from '../lib/webhook.js'
import { assertBookable, isWithinAdvanceBookingWindow, lockAssetForBooking, isOverlapConstraintViolation } from '../lib/booking.js'

const createRecurringSchema = z.object({
  assetId: z.string().min(1),
  frequency: z.enum(['DAILY', 'WEEKLY', 'MONTHLY']).default('WEEKLY'),
  dayOfWeek: z.number().int().min(0).max(6).optional(),
  startTime: z.string().regex(/^\d{2}:\d{2}$/, 'startTime must be HH:MM'),
  endTime: z.string().regex(/^\d{2}:\d{2}$/, 'endTime must be HH:MM'),
  firstDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'firstDate must be YYYY-MM-DD'),
  lastDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'lastDate must be YYYY-MM-DD'),
}).refine(
  (d) => d.frequency !== 'WEEKLY' || d.dayOfWeek !== undefined,
  { message: 'dayOfWeek is required for weekly recurrence', path: ['dayOfWeek'] },
)

function parseTimeToMinutes(time: string): number {
  const [h, m] = time.split(':').map(Number)
  return h * 60 + m
}

function buildSlotDatetime(dateUtcMidnight: Date, timeHHMM: string): Date {
  const [h, m] = timeHHMM.split(':').map(Number)
  const dt = new Date(dateUtcMidnight)
  dt.setUTCHours(h, m, 0, 0)
  return dt
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

    const { assetId, frequency, dayOfWeek, startTime, endTime, firstDate, lastDate } = result.data

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

    const slots = occurrenceDates.map((d) => ({
      startsAt: buildSlotDatetime(d, startTime),
      endsAt: buildSlotDatetime(d, endTime),
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

    try {
      const rule = await prisma.$transaction(async (tx) => {
        // Serialise booking creation for this asset against all other paths
        await lockAssetForBooking(tx, assetId)

        // Check all slots for conflicts atomically
        for (const slot of slots) {
          const conflict = await tx.booking.findFirst({
            where: {
              assetId,
              status: 'CONFIRMED',
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
                status: 'CONFIRMED',
              })),
            },
          },
          include: {
            bookings: { select: { id: true, startsAt: true, endsAt: true } },
            asset: { select: { id: true, name: true, floor: { select: { name: true, building: { select: { name: true } } } } } },
          },
        })

        return createdRule
      })

      // Single confirmation notification for the first booking in the series
      await enqueueNotification({
        type: NotificationType.BOOKING_CONFIRMED,
        userId: request.user.id,
        bookingId: rule.bookings[0].id,
      })

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
          where: { status: 'CONFIRMED', startsAt: { gte: new Date() } },
          select: { id: true, startsAt: true, endsAt: true },
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

  // DELETE /recurring-bookings/:id — cancel rule + all future bookings
  fastify.delete('/:id', { preHandler: [requireAuth] }, async (request, reply) => {
    const { id } = request.params as { id: string }
    const rule = await prisma.recurringBookingRule.findUnique({
      where: { id },
      select: { id: true, userId: true, status: true },
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

    for (const b of futureBookings) {
      const nextQueued = await promoteNextQueueEntry(b.assetId, b.startsAt, b.endsAt)
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

    return reply.status(200).send({ data: { ok: true } })
  })
}
