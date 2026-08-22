import { PgBoss, type Job } from 'pg-boss'
import { env } from '../env.js'
import { prisma } from './prisma.js'
import { buildBookingIcs } from './ical.js'
import { sendEmail, renderBookingConfirmed, renderBookingCancelled, renderBookingCancelledByAdmin, renderBookingNoShow, renderBookingReminder, renderQueueJoined, renderQueuePromoted, renderQueueExpired, renderQueueClaimExpiring, renderWelcome, renderFloorAvailable, renderAssetAssigned, renderWeeklyReport, renderBookingTransferRequested, renderBookingTransferAccepted, renderBookingTransferDeclined, renderBookingTransferExpired, renderBookingSwapRequested, renderBookingSwapAccepted, renderBookingSwapDeclined, renderBookingSwapExpired, renderManagerRequestSubmitted, renderManagerRequestApproved, renderManagerRequestRejected, renderManagerRequestExpired, renderLeaseExpiring, renderLeaseExpired, renderBookingPendingApproval, renderBookingApproved, renderBookingRejected, renderBallotWon, renderBallotLost, interpolateTemplate, stripHtmlToText, formatDate } from './mailer.js'
import { randomUUID } from 'crypto'
import { pruneExpiredBlocklistEntries } from './token-blocklist.js'
import { NotificationType } from '@roomer/shared'
import { dispatchWebhook } from './webhook.js'
import { lockAssetForQueue } from './booking.js'
import { resolveBuildingTimezone } from './timezone.js'
import { toZonedTime } from 'date-fns-tz'
import { getBuildingAdminUserIds } from '../middleware/requireRole.js'
import { sendPushNotification } from './push.js'
import { recordAuditLog } from './audit.js'

// Types worth interrupting someone's phone for — the rest stay in-app/email
// only. Scoped per the #76 phase-2 design discussion: the 3 originally named
// (queue promotion, reminders, floor availability) plus transfer/swap
// *requested* (needs a timely response from the recipient) and the
// claim-expiring nudge. Deliberately excludes the *outcome* notifications
// (accepted/declined/expired, confirmed/cancelled, etc.) — those aren't
// time-sensitive enough to justify a push.
const PUSH_ELIGIBLE_TYPES = new Set<NotificationType>([
  NotificationType.QUEUE_PROMOTED,
  NotificationType.BOOKING_REMINDER,
  NotificationType.FLOOR_AVAILABLE,
  NotificationType.BOOKING_TRANSFER_REQUESTED,
  NotificationType.BOOKING_SWAP_REQUESTED,
  NotificationType.QUEUE_CLAIM_EXPIRING,
  NotificationType.BOOKING_PENDING_APPROVAL,
])

// Priority order for picking a push notification's click-through target from
// whichever URL each branch happened to put in templateVars.
const PUSH_URL_KEYS = ['claimUrl', 'bookingUrl', 'floorUrl', 'queueUrl', 'bookingsUrl'] as const

let boss: PgBoss | null = null

export function getBoss(): PgBoss {
  if (!boss) {
    boss = new PgBoss(env.DATABASE_URL)
  }
  return boss
}

/** How long a promoted queue entry has to be claimed before it expires. */
export const CLAIM_DEADLINE_MS = 2 * 60 * 60 * 1000 // 2 hours

/**
 * Atomically promote the highest-position WAITING queue entry overlapping
 * [periodStart, periodEnd) on an asset. Every caller that frees up a slot
 * (booking cancellation, no-show release, claim-deadline expiry) must go
 * through this instead of a bare findFirst+update: without the per-asset
 * queue lock, two callers racing on the same asset (e.g. two overlapping
 * expired PROMOTED entries, or a cancellation racing the expiry cron) can
 * both read the same "next" WAITING entry before either commits, then both
 * promote it — sending two QUEUE_PROMOTED emails with different claim
 * tokens where only the last-written token is still valid, and silently
 * skipping the entry that should have been promoted for the other slot.
 */
export async function promoteNextQueueEntry(
  assetId: string,
  periodStart: Date,
  periodEnd: Date,
): Promise<{ id: string; userId: string; assetId: string; claimDeadline: Date } | null> {
  return prisma.$transaction(async (tx) => {
    await lockAssetForQueue(tx, assetId)

    const next = await tx.queueEntry.findFirst({
      where: {
        assetId,
        status: 'WAITING',
        wantedStartsAt: { lt: periodEnd },
        wantedEndsAt: { gt: periodStart },
      },
      orderBy: { position: 'asc' },
    })
    if (!next) return null

    const claimDeadline = new Date(Date.now() + CLAIM_DEADLINE_MS)
    await tx.queueEntry.update({
      where: { id: next.id },
      data: { status: 'PROMOTED', claimDeadline, claimToken: randomUUID() },
    })

    // Same compaction the leave-queue route already does when an entry
    // ahead is removed (queue.ts DELETE /:id) — without it, everyone still
    // WAITING behind a promoted entry keeps their old position number
    // forever, showing a permanently stale (too-high) "your position" to
    // the end user even though they just moved up in line.
    await tx.queueEntry.updateMany({
      where: {
        assetId,
        status: 'WAITING',
        position: { gt: next.position },
        wantedStartsAt: { lt: next.wantedEndsAt },
        wantedEndsAt: { gt: next.wantedStartsAt },
      },
      data: { position: { decrement: 1 } },
    })

    return { id: next.id, userId: next.userId, assetId: next.assetId, claimDeadline }
  })
}

type CancellableBooking = {
  id: string
  userId: string
  assetId: string
  assetName: string
  assetFloorId: string | null
  assetPrimaryZoneId: string | null
  startsAt: Date
  endsAt: Date
  icsSequence: number
  recurringRuleId?: string | null
}

/**
 * Cancel every given CONFIRMED-future booking, notify each original booker,
 * and promote the next queued entry for each freed slot — same
 * cancel+promote+notify shape as a recurring-series cancellation (see
 * recurring.ts DELETE /:id). Shared core for cancelFutureBookingsForFloors,
 * cancelFutureBookingsForAssets and cancelFutureBookingsForUser.
 *
 * `skipQueuePromotion` must be set by any caller whose asset(s) are about to
 * be hard-deleted (not just unplaced/detached): the asset won't be bookable
 * for anyone to promote into, and cascade-deleting it destroys the Booking/
 * QueueEntry rows before the async QUEUE_PROMOTED notification job would
 * even run (see #228).
 *
 * `fanOutOnFree` opts into notifying floor subscribers (same as a single
 * ad-hoc booking cancel, bookings.ts DELETE /:id) when a freed slot has no
 * one to promote. Only cancelFutureBookingsForUser sets it — the
 * floor/asset-delete callers cancel bookings on a floor or asset that's
 * about to be deleted or unplaced, so there's nothing left to point
 * subscribers back at by the time the notification would be read.
 */
async function cancelBookingsAndPromoteQueues(
  bookings: CancellableBooking[],
  logMsg: string,
  opts: { skipQueuePromotion?: boolean; fanOutOnFree?: boolean } = {},
): Promise<void> {
  if (bookings.length === 0) return

  await prisma.booking.updateMany({
    where: { id: { in: bookings.map((b) => b.id) } },
    data: { status: 'CANCELLED' },
  })

  // Same series-cancel-then-status-flip recurring.ts DELETE /:id does — without
  // this, deleting the floor/building/asset underneath a recurring rule cancels
  // every future Booking row but leaves the rule itself stuck ACTIVE forever
  // (nothing else ever transitions its status), so it keeps showing as an
  // active series pointing at a desk that no longer exists.
  const ruleIds = [...new Set(bookings.map((b) => b.recurringRuleId).filter((id): id is string => !!id))]
  if (ruleIds.length > 0) {
    await prisma.recurringBookingRule.updateMany({
      where: { id: { in: ruleIds }, status: 'ACTIVE' },
      data: { status: 'CANCELLED' },
    })
  }

  for (const b of bookings) {
    // Snapshot the rendering data at enqueue time (not just bookingId) so the
    // notification survives even if the caller cascade-deletes this Booking
    // row (via a hard asset delete) before the async job is delivered.
    await enqueueNotification({
      type: NotificationType.BOOKING_CANCELLED_BY_ADMIN,
      userId: b.userId,
      bookingId: b.id,
      cancelledAssetName: b.assetName,
      cancelledStartsAt: b.startsAt.toISOString(),
      cancelledEndsAt: b.endsAt.toISOString(),
      cancelledIcsSequence: b.icsSequence,
    })
    // Same event a single ad-hoc cancel (bookings.ts DELETE /:id) and a
    // recurring-series cancel (recurring.ts) both fire — this shared helper
    // (floor/building/zone delete, blocking a user) is a sibling "a booking
    // just got cancelled" path and was the one place that never dispatched
    // it, leaving any integration subscribed to booking.cancelled blind to
    // exactly the cancellations most likely to affect many bookings at once.
    dispatchWebhook('booking.cancelled', { id: b.id, userId: b.userId, assetId: b.assetId }).catch(() => {})

    if (!opts.skipQueuePromotion) {
      const nextQueued = await promoteNextQueueEntry(b.assetId, b.startsAt, b.endsAt)
      if (nextQueued) {
        await enqueueNotification({
          type: NotificationType.QUEUE_PROMOTED,
          userId: nextQueued.userId,
          queueEntryId: nextQueued.id,
          claimDeadline: nextQueued.claimDeadline.toISOString(),
        })
        dispatchWebhook('queue.promoted', { id: nextQueued.id, userId: nextQueued.userId, assetId: nextQueued.assetId, claimDeadline: nextQueued.claimDeadline.toISOString() }).catch(() => {})
      } else if (opts.fanOutOnFree && b.assetFloorId) {
        const slotDate = b.startsAt.toISOString().slice(0, 10)
        await fanOutFloorAvailable(b.assetId, b.assetFloorId, b.assetPrimaryZoneId, slotDate, b.userId).catch(() => {})
      }
    }
  }

  process.stdout.write(JSON.stringify({ level: 'info', msg: logMsg, count: bookings.length }) + '\n')
}

/**
 * Cancel every future CONFIRMED booking on the given floors (see
 * cancelBookingsAndPromoteQueues).
 *
 * Used before deleting a floor (directly, or via a building delete cascading
 * its floors) so a booking never sits CONFIRMED for a desk on a floor that no
 * longer exists. Must be called — and its bookings read — BEFORE the actual
 * floor/building delete: once the floor is gone, Asset.floorId is SetNull and
 * there is no longer any way to find which bookings belonged to it.
 */
export async function cancelFutureBookingsForFloors(floorIds: string[]): Promise<void> {
  if (floorIds.length === 0) return
  const now = new Date()
  const bookings = await prisma.booking.findMany({
    // PENDING_APPROVAL reserves its slot exactly like CONFIRMED (#74) — a
    // still-pending request on a floor about to be deleted needs releasing
    // and notifying the same as a confirmed one, otherwise it's silently
    // deleted by the Booking->Asset cascade with no cancellation email at all.
    where: { status: { in: ['CONFIRMED', 'PENDING_APPROVAL'] }, startsAt: { gt: now }, asset: { floorId: { in: floorIds } } },
    select: { id: true, userId: true, assetId: true, startsAt: true, endsAt: true, recurringRuleId: true, icsSequence: true, asset: { select: { name: true, floorId: true, primaryZoneId: true } } },
  })
  await cancelBookingsAndPromoteQueues(
    bookings.map((b) => ({ ...b, assetName: b.asset.name, assetFloorId: b.asset.floorId, assetPrimaryZoneId: b.asset.primaryZoneId })),
    '[queue] Cancelled bookings on deleted floor(s)',
  )
}

/**
 * Cancel every future CONFIRMED booking on the given assets (see
 * cancelBookingsAndPromoteQueues).
 *
 * Used before removing assets from a floor plan in bulk (e.g. deleting a zone
 * unplaces every asset still in it — see zones.ts DELETE /:id) so a booking
 * never sits CONFIRMED for a desk that just became unreachable from any floor
 * plan. Must be called before the unplacing update.
 *
 * `skipQueuePromotion` must be true when the caller is about to hard-delete
 * these assets rather than just unplace them (see cancelBookingsAndPromoteQueues).
 */
export async function cancelFutureBookingsForAssets(assetIds: string[], opts: { skipQueuePromotion?: boolean } = {}): Promise<void> {
  if (assetIds.length === 0) return
  const now = new Date()
  const bookings = await prisma.booking.findMany({
    // See cancelFutureBookingsForFloors — PENDING_APPROVAL reserves its slot
    // exactly like CONFIRMED (#74), so it needs releasing here too, not just
    // silently cascade-deleted with the asset (e.g. DELETE /assets/:id).
    where: { status: { in: ['CONFIRMED', 'PENDING_APPROVAL'] }, startsAt: { gt: now }, assetId: { in: assetIds } },
    select: { id: true, userId: true, assetId: true, startsAt: true, endsAt: true, recurringRuleId: true, icsSequence: true, asset: { select: { name: true, floorId: true, primaryZoneId: true } } },
  })
  await cancelBookingsAndPromoteQueues(
    bookings.map((b) => ({ ...b, assetName: b.asset.name, assetFloorId: b.asset.floorId, assetPrimaryZoneId: b.asset.primaryZoneId })),
    '[queue] Cancelled bookings on unplaced asset(s)',
    opts,
  )
}

/**
 * Cancel every future CONFIRMED booking a user holds, across every asset (see
 * cancelBookingsAndPromoteQueues) — used when an admin blocks a user's
 * account so a desk doesn't stay silently CONFIRMED-and-unusable under a
 * login the owner can no longer manage or cancel themselves.
 */
export async function cancelFutureBookingsForUser(userId: string): Promise<void> {
  const now = new Date()
  const bookings = await prisma.booking.findMany({
    // PENDING_APPROVAL reserves its slot exactly like CONFIRMED (#74) — a
    // blocked user's still-pending request otherwise keeps reserving the
    // slot under an account nobody can manage, and would still confirm into
    // a real booking if a manager later approved it.
    where: { status: { in: ['CONFIRMED', 'PENDING_APPROVAL'] }, startsAt: { gt: now }, userId },
    select: { id: true, userId: true, assetId: true, startsAt: true, endsAt: true, recurringRuleId: true, icsSequence: true, asset: { select: { name: true, floorId: true, primaryZoneId: true } } },
  })
  await cancelBookingsAndPromoteQueues(
    bookings.map((b) => ({ ...b, assetName: b.asset.name, assetFloorId: b.asset.floorId, assetPrimaryZoneId: b.asset.primaryZoneId })),
    '[queue] Cancelled bookings for blocked user',
    { fanOutOnFree: true },
  )
}

/**
 * Cancel a user's own WAITING/PROMOTED queue entries and compact the
 * positions behind each one — same shape as the user-initiated "leave queue"
 * path (queue.ts DELETE /:id), just applied to every entry at once. Used
 * alongside cancelFutureBookingsForUser when blocking an account, so a
 * blocked user can't still be promoted into a slot they have no way to claim.
 */
export async function cancelQueueEntriesForUser(userId: string): Promise<void> {
  const entries = await prisma.queueEntry.findMany({
    where: { userId, status: { in: ['WAITING', 'PROMOTED'] } },
  })
  for (const entry of entries) {
    await prisma.queueEntry.update({ where: { id: entry.id }, data: { status: 'CANCELLED' } })
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
  }
}

/**
 * Release every desk a user is permanently assigned to — same restore-prior-
 * bookingStatus behavior as the single unassign route (assets.ts DELETE
 * /:id/user-assignments/:userId), just applied to every assignment the user
 * holds. Used when blocking an account so it doesn't keep "owning" a desk
 * indefinitely with no one able to reassign it away.
 */
export async function releaseAssetAssignmentsForUser(userId: string): Promise<void> {
  const assignments = await prisma.assetUserAssignment.findMany({ where: { userId }, select: { assetId: true } })
  if (assignments.length === 0) return
  await prisma.assetUserAssignment.deleteMany({ where: { userId } })
  for (const { assetId } of assignments) {
    const remaining = await prisma.assetUserAssignment.count({ where: { assetId } })
    if (remaining === 0) {
      const current = await prisma.asset.findUnique({ where: { id: assetId }, select: { bookingStatus: true, priorBookingStatus: true } })
      if (current?.bookingStatus === 'ASSIGNED') {
        await prisma.asset.update({
          where: { id: assetId },
          data: { bookingStatus: current.priorBookingStatus ?? 'OPEN', priorBookingStatus: null },
        })
      }
    }
  }
}

// ─── Notification job payload ─────────────────────────────────────────────────

export interface NotificationJobData {
  type: NotificationType
  userId: string
  bookingId?: string
  queueEntryId?: string
  claimDeadline?: string
  floorId?: string
  zoneId?: string
  assetId?: string
  slotDate?: string
  /**
   * Fallback rendering data for BOOKING_CANCELLED_BY_ADMIN, used only when
   * the live `bookingId` lookup below comes back empty. Needed because
   * cancelBookingsAndPromoteQueues enqueues this notification before some
   * callers go on to hard-delete the asset, which cascades and destroys the
   * Booking row (schema.prisma `onDelete: Cascade`) well before this async
   * job is picked up — without a snapshot taken at enqueue time, the
   * cancellation notice would silently vanish (see #228).
   */
  cancelledAssetName?: string
  cancelledStartsAt?: string
  cancelledEndsAt?: string
  cancelledIcsSequence?: number
  /** BookingTransfer id / BookingSwap id — see the transfer and swap notification branches below. */
  transferId?: string
  swapId?: string
  /** FloorManagerRequest id — see the MANAGER_REQUEST_* branches below. */
  managerRequestId?: string
  /** BuildingLease id — see the LEASE_* branches below. */
  leaseId?: string
  /** BallotEntry id — see the BALLOT_* branches below (#159). */
  ballotEntryId?: string
}

// ─── Worker: send-notification ────────────────────────────────────────────────

async function handleSendNotification(
  jobs: Job<NotificationJobData>[],
): Promise<void> {
  for (const job of jobs) {
    await processSendNotification(job)
  }
}

async function processSendNotification(
  job: Job<NotificationJobData>,
): Promise<void> {
  const { type, userId, bookingId, queueEntryId, claimDeadline, floorId, zoneId, assetId, slotDate, transferId, swapId, managerRequestId, leaseId, ballotEntryId } = job.data

  const user = await prisma.user.findUnique({ where: { id: userId } })
  if (!user) {
    process.stderr.write(JSON.stringify({ level: 'warn', msg: '[queue] User not found for notification', userId }) + '\n')
    return
  }

  let title = ''
  let body = ''
  let emailPayload: { subject: string; html: string; text: string } | null = null
  let templateVars: Record<string, string> = {}
  let icalEvent: { method: string; content: string } | undefined

  if (type === NotificationType.BOOKING_CONFIRMED && bookingId) {
    const booking = await prisma.booking.findUnique({
      where: { id: bookingId },
      include: { asset: { include: { primaryZone: { select: { name: true } }, floor: { select: { name: true, buildingId: true, building: { select: { name: true } } } } } } },
    })
    if (booking) {
      const tz = await resolveBuildingTimezone(prisma, booking.asset.floor?.buildingId)
      // A guest booking (see #79) is still confirmed to the host, not the
      // guest (who gets their own separate invite email) — naming the guest
      // here just distinguishes it from the host's own bookings at a glance.
      const guestSuffix = booking.guestName ? ` for ${booking.guestName}` : ''
      title = `Booking confirmed${guestSuffix} — ${booking.asset.name}`
      body = `Your booking${guestSuffix} for ${booking.asset.name} is confirmed from ${formatDate(booking.startsAt, tz)} to ${formatDate(booking.endsAt, tz)}`
      emailPayload = renderBookingConfirmed(booking, user, {
        name: booking.asset.name,
        zoneName: booking.asset.primaryZone?.name ?? '',
        floorName: booking.asset.floor?.name ?? '',
      }, tz)
      icalEvent = {
        method: 'REQUEST',
        content: buildBookingIcs({
          id: booking.id, startsAt: booking.startsAt, endsAt: booking.endsAt,
          assetName: booking.asset.name,
          zoneName: booking.asset.primaryZone?.name,
          floorName: booking.asset.floor?.name,
          buildingName: booking.asset.floor?.building?.name,
          sequence: booking.icsSequence,
          attendeeEmail: user.email, attendeeName: user.displayName,
        }, 'REQUEST'),
      }
      templateVars = {
        userName: user.displayName, userEmail: user.email,
        assetName: booking.asset.name,
        zoneName: booking.asset.primaryZone?.name ?? '',
        floorName: booking.asset.floor?.name ?? '',
        startsAt: formatDate(booking.startsAt, tz), endsAt: formatDate(booking.endsAt, tz),
        notes: booking.notes ?? '',
        bookingUrl: `${env.APP_URL}/bookings/${booking.id}`,
        appUrl: env.APP_URL,
      }
    }
  } else if (type === NotificationType.BOOKING_CANCELLED && bookingId) {
    const booking = await prisma.booking.findUnique({
      where: { id: bookingId },
      include: { asset: { include: { floor: { select: { buildingId: true } } } } },
    })
    if (booking) {
      const tz = await resolveBuildingTimezone(prisma, booking.asset.floor?.buildingId)
      title = `Booking cancelled — ${booking.asset.name}`
      body = `Your booking for ${booking.asset.name} has been cancelled.`
      emailPayload = renderBookingCancelled(booking, user, booking.asset, tz)
      icalEvent = {
        method: 'CANCEL',
        content: buildBookingIcs({
          id: booking.id, startsAt: booking.startsAt, endsAt: booking.endsAt,
          assetName: booking.asset.name,
          sequence: booking.icsSequence + 1,
          attendeeEmail: user.email, attendeeName: user.displayName,
        }, 'CANCEL'),
      }
      templateVars = {
        userName: user.displayName, userEmail: user.email,
        assetName: booking.asset.name,
        startsAt: formatDate(booking.startsAt, tz), endsAt: formatDate(booking.endsAt, tz),
        bookingsUrl: `${env.APP_URL}/bookings`, appUrl: env.APP_URL,
      }
    }
  } else if (type === NotificationType.BOOKING_NO_SHOW && bookingId) {
    const booking = await prisma.booking.findUnique({
      where: { id: bookingId },
      include: { asset: { include: { floor: { select: { buildingId: true } } } } },
    })
    if (booking) {
      const tz = await resolveBuildingTimezone(prisma, booking.asset.floor?.buildingId)
      title = `Booking released — ${booking.asset.name}`
      body = `Your booking for ${booking.asset.name} was released because you didn't check in.`
      emailPayload = renderBookingNoShow(booking, user, booking.asset, tz)
      // Same as any other cancellation path — without a CANCEL, the invite
      // this booking's confirmation originally sent stays "confirmed" in the
      // booker's calendar forever, even though the desk was released.
      icalEvent = {
        method: 'CANCEL',
        content: buildBookingIcs({
          id: booking.id, startsAt: booking.startsAt, endsAt: booking.endsAt,
          assetName: booking.asset.name,
          sequence: booking.icsSequence + 1,
          attendeeEmail: user.email, attendeeName: user.displayName,
        }, 'CANCEL'),
      }
      templateVars = {
        userName: user.displayName, userEmail: user.email,
        assetName: booking.asset.name,
        startsAt: formatDate(booking.startsAt, tz), endsAt: formatDate(booking.endsAt, tz),
        bookingsUrl: `${env.APP_URL}/bookings`, appUrl: env.APP_URL,
      }
    }
  } else if (type === NotificationType.BOOKING_CANCELLED_BY_ADMIN && bookingId) {
    const booking = await prisma.booking.findUnique({
      where: { id: bookingId },
      include: { asset: { include: { floor: { select: { buildingId: true } } } } },
    })
    if (booking) {
      const tz = await resolveBuildingTimezone(prisma, booking.asset.floor?.buildingId)
      title = `Booking cancelled by admin — ${booking.asset.name}`
      body = `Your booking for ${booking.asset.name} has been cancelled by an administrator.`
      emailPayload = renderBookingCancelledByAdmin(booking, user, booking.asset, tz)
      icalEvent = {
        method: 'CANCEL',
        content: buildBookingIcs({
          id: booking.id, startsAt: booking.startsAt, endsAt: booking.endsAt,
          assetName: booking.asset.name,
          sequence: booking.icsSequence + 1,
          attendeeEmail: user.email, attendeeName: user.displayName,
        }, 'CANCEL'),
      }
      templateVars = {
        userName: user.displayName, userEmail: user.email,
        assetName: booking.asset.name,
        startsAt: formatDate(booking.startsAt, tz), endsAt: formatDate(booking.endsAt, tz),
        bookingsUrl: `${env.APP_URL}/bookings`, appUrl: env.APP_URL,
      }
    } else if (job.data.cancelledAssetName && job.data.cancelledStartsAt && job.data.cancelledEndsAt) {
      // Live row is gone (cascade-deleted) — render from the enqueue-time
      // snapshot instead of dropping the notice. See NotificationJobData's
      // cancelled* fields for why this can happen.
      const assetName = job.data.cancelledAssetName
      const startsAt = new Date(job.data.cancelledStartsAt)
      const endsAt = new Date(job.data.cancelledEndsAt)
      title = `Booking cancelled by admin — ${assetName}`
      body = `Your booking for ${assetName} has been cancelled by an administrator.`
      emailPayload = renderBookingCancelledByAdmin({ id: bookingId, startsAt, endsAt }, user, { name: assetName })
      icalEvent = {
        method: 'CANCEL',
        content: buildBookingIcs({
          id: bookingId, startsAt, endsAt, assetName,
          sequence: (job.data.cancelledIcsSequence ?? 0) + 1,
          attendeeEmail: user.email, attendeeName: user.displayName,
        }, 'CANCEL'),
      }
      templateVars = {
        userName: user.displayName, userEmail: user.email,
        assetName,
        startsAt: formatDate(startsAt), endsAt: formatDate(endsAt),
        bookingsUrl: `${env.APP_URL}/bookings`, appUrl: env.APP_URL,
      }
    }
  } else if (type === NotificationType.BOOKING_REMINDER && bookingId) {
    const booking = await prisma.booking.findUnique({
      where: { id: bookingId },
      include: { asset: { include: { primaryZone: { select: { name: true } }, floor: { select: { name: true, buildingId: true } } } } },
    })
    if (booking) {
      const tz = await resolveBuildingTimezone(prisma, booking.asset.floor?.buildingId)
      title = `Reminder — ${booking.asset.name} booking coming up`
      body = `Your booking starts at ${formatDate(booking.startsAt, tz)}.`
      emailPayload = renderBookingReminder(booking, user, {
        name: booking.asset.name,
        zoneName: booking.asset.primaryZone?.name ?? '',
        floorName: booking.asset.floor?.name ?? '',
      }, tz)
      templateVars = {
        userName: user.displayName, userEmail: user.email,
        assetName: booking.asset.name,
        zoneName: booking.asset.primaryZone?.name ?? '',
        floorName: booking.asset.floor?.name ?? '',
        startsAt: formatDate(booking.startsAt, tz), endsAt: formatDate(booking.endsAt, tz),
        bookingUrl: `${env.APP_URL}/bookings/${booking.id}`,
        appUrl: env.APP_URL,
      }
    }
  } else if (type === NotificationType.QUEUE_JOINED && queueEntryId) {
    const entry = await prisma.queueEntry.findUnique({
      where: { id: queueEntryId },
      include: { asset: true },
    })
    if (entry) {
      title = `Joined queue — ${entry.asset.name}`
      body = `You are #${entry.position} in the queue for ${entry.asset.name}.`
      emailPayload = renderQueueJoined(entry, user, entry.asset)
      templateVars = {
        userName: user.displayName, userEmail: user.email,
        assetName: entry.asset.name,
        position: String(entry.position),
        wantedStartsAt: formatDate(entry.wantedStartsAt), wantedEndsAt: formatDate(entry.wantedEndsAt),
        queueUrl: `${env.APP_URL}/queue`, appUrl: env.APP_URL,
      }
    }
  } else if (type === NotificationType.QUEUE_PROMOTED && queueEntryId) {
    const entry = await prisma.queueEntry.findUnique({
      where: { id: queueEntryId },
      include: { asset: true },
    })
    if (entry && claimDeadline && entry.claimToken) {
      title = `Asset available — ${entry.asset.name}`
      body = `Claim your booking by ${formatDate(new Date(claimDeadline))}.`
      emailPayload = renderQueuePromoted(entry, user, entry.asset, new Date(claimDeadline), entry.claimToken)
      templateVars = {
        userName: user.displayName, userEmail: user.email,
        assetName: entry.asset.name,
        wantedStartsAt: formatDate(entry.wantedStartsAt), wantedEndsAt: formatDate(entry.wantedEndsAt),
        claimDeadline: formatDate(new Date(claimDeadline)),
        claimUrl: `${env.APP_URL}/queue/claim?token=${encodeURIComponent(entry.claimToken)}`,
        appUrl: env.APP_URL,
      }
    }
  } else if (type === NotificationType.QUEUE_CLAIM_EXPIRING && queueEntryId) {
    const entry = await prisma.queueEntry.findUnique({
      where: { id: queueEntryId },
      include: { asset: true },
    })
    if (entry && claimDeadline && entry.claimToken) {
      title = `Claim window closing soon — ${entry.asset.name}`
      body = `Claim your booking for ${entry.asset.name} by ${formatDate(new Date(claimDeadline))}.`
      emailPayload = renderQueueClaimExpiring(entry, user, entry.asset, new Date(claimDeadline), entry.claimToken)
      templateVars = {
        userName: user.displayName, userEmail: user.email,
        assetName: entry.asset.name,
        wantedStartsAt: formatDate(entry.wantedStartsAt), wantedEndsAt: formatDate(entry.wantedEndsAt),
        claimDeadline: formatDate(new Date(claimDeadline)),
        claimUrl: `${env.APP_URL}/queue/claim?token=${encodeURIComponent(entry.claimToken)}`,
        appUrl: env.APP_URL,
      }
    }
  } else if (type === NotificationType.FLOOR_AVAILABLE && floorId && assetId && slotDate) {
    const [floor, asset] = await Promise.all([
      prisma.floor.findUnique({ where: { id: floorId }, select: { id: true, name: true } }),
      prisma.asset.findUnique({ where: { id: assetId }, select: { name: true } }),
    ])
    const zone = zoneId
      ? await prisma.zone.findUnique({ where: { id: zoneId }, select: { name: true } })
      : null
    if (floor && asset) {
      title = `Desk available — ${floor.name}${zone ? ` · ${zone.name}` : ''}`
      body = `${asset.name} is now free on ${slotDate}.`
      emailPayload = renderFloorAvailable(floor, zone, asset, slotDate)
      templateVars = {
        floorName: floor.name, zoneName: zone?.name ?? '',
        assetName: asset.name, slotDate,
        floorUrl: `${env.APP_URL}/floors/${floor.id}?date=${slotDate}`,
        appUrl: env.APP_URL,
      }
    }
  } else if (type === NotificationType.QUEUE_EXPIRED && queueEntryId) {
    const entry = await prisma.queueEntry.findUnique({
      where: { id: queueEntryId },
      include: { asset: true },
    })
    if (entry) {
      title = `Queue entry expired — ${entry.asset.name}`
      body = `Your queue entry for ${entry.asset.name} has expired.`
      emailPayload = renderQueueExpired(entry, user, entry.asset)
      templateVars = {
        userName: user.displayName, userEmail: user.email,
        assetName: entry.asset.name,
        wantedStartsAt: formatDate(entry.wantedStartsAt), wantedEndsAt: formatDate(entry.wantedEndsAt),
        queueUrl: `${env.APP_URL}/queue`, appUrl: env.APP_URL,
      }
    }
  } else if (type === NotificationType.ASSET_ASSIGNED && assetId) {
    const asset = await prisma.asset.findUnique({ where: { id: assetId }, select: { name: true } })
    if (asset) {
      // Permanent assignment (AssetUserAssignment, the only live assignment
      // mechanism — see #201) has no assignedAt/notes fields of its own, so
      // there's nothing more specific to show than "just now".
      const assignedAt = new Date()
      const notes = null
      title = `Asset assigned to you — ${asset.name}`
      body = `${asset.name} has been assigned to you.`
      emailPayload = renderAssetAssigned({ assignedAt, notes }, user, asset)
      templateVars = {
        userName: user.displayName, userEmail: user.email,
        assetName: asset.name,
        assignedAt: formatDate(assignedAt),
        notes: notes ?? '',
        appUrl: env.APP_URL,
      }
    }
  } else if (type === NotificationType.BOOKING_TRANSFER_REQUESTED && transferId) {
    const transfer = await prisma.bookingTransfer.findUnique({
      where: { id: transferId },
      include: { booking: { include: { asset: true } }, fromUser: true },
    })
    if (transfer) {
      title = `Transfer request — ${transfer.booking.asset.name}`
      body = `${transfer.fromUser.displayName} wants to transfer their ${transfer.booking.asset.name} booking to you.`
      emailPayload = renderBookingTransferRequested(transfer.booking, user, transfer.fromUser, transfer.booking.asset)
      templateVars = {
        userName: user.displayName, userEmail: user.email,
        fromUserName: transfer.fromUser.displayName,
        assetName: transfer.booking.asset.name,
        startsAt: formatDate(transfer.booking.startsAt), endsAt: formatDate(transfer.booking.endsAt),
        bookingsUrl: `${env.APP_URL}/bookings`, appUrl: env.APP_URL,
      }
    }
  } else if (type === NotificationType.BOOKING_TRANSFER_ACCEPTED && transferId) {
    const transfer = await prisma.bookingTransfer.findUnique({
      where: { id: transferId },
      include: { booking: { include: { asset: true } }, toUser: true },
    })
    if (transfer) {
      title = `Transfer accepted — ${transfer.booking.asset.name}`
      body = `${transfer.toUser.displayName} accepted your transfer of ${transfer.booking.asset.name}.`
      emailPayload = renderBookingTransferAccepted(transfer.booking, user, transfer.toUser, transfer.booking.asset)
      // This notification goes to the FORMER owner (see bookings.ts transfer
      // accept). The BOOKING_CONFIRMED job sent alongside it only sends a
      // fresh REQUEST to the NEW owner's calendar — a different mailbox
      // entirely, so it does nothing for this recipient's copy of the
      // original invite. Without an explicit CANCEL here, the former owner's
      // calendar keeps showing the booking as confirmed forever, which is
      // exactly what renderBookingTransferAccepted's copy ("it's no longer
      // on your calendar") wrongly promised was already handled.
      icalEvent = {
        method: 'CANCEL',
        content: buildBookingIcs({
          id: transfer.booking.id, startsAt: transfer.booking.startsAt, endsAt: transfer.booking.endsAt,
          assetName: transfer.booking.asset.name,
          sequence: transfer.booking.icsSequence,
          attendeeEmail: user.email, attendeeName: user.displayName,
        }, 'CANCEL'),
      }
      templateVars = {
        userName: user.displayName, userEmail: user.email,
        toUserName: transfer.toUser.displayName,
        assetName: transfer.booking.asset.name,
        startsAt: formatDate(transfer.booking.startsAt), endsAt: formatDate(transfer.booking.endsAt),
        bookingsUrl: `${env.APP_URL}/bookings`, appUrl: env.APP_URL,
      }
    }
  } else if (type === NotificationType.BOOKING_TRANSFER_DECLINED && transferId) {
    const transfer = await prisma.bookingTransfer.findUnique({
      where: { id: transferId },
      include: { booking: { include: { asset: true } }, toUser: true },
    })
    if (transfer) {
      title = `Transfer declined — ${transfer.booking.asset.name}`
      body = `${transfer.toUser.displayName} declined your transfer of ${transfer.booking.asset.name}.`
      emailPayload = renderBookingTransferDeclined(transfer.booking, user, transfer.toUser, transfer.booking.asset)
      templateVars = {
        userName: user.displayName, userEmail: user.email,
        toUserName: transfer.toUser.displayName,
        assetName: transfer.booking.asset.name,
        startsAt: formatDate(transfer.booking.startsAt), endsAt: formatDate(transfer.booking.endsAt),
        bookingsUrl: `${env.APP_URL}/bookings`, appUrl: env.APP_URL,
      }
    }
  } else if (type === NotificationType.BOOKING_TRANSFER_EXPIRED && transferId) {
    const transfer = await prisma.bookingTransfer.findUnique({
      where: { id: transferId },
      include: { booking: { include: { asset: true } } },
    })
    if (transfer) {
      title = `Transfer request expired — ${transfer.booking.asset.name}`
      body = `Nobody responded to your transfer of ${transfer.booking.asset.name} in time — it's still yours.`
      emailPayload = renderBookingTransferExpired(transfer.booking, user, transfer.booking.asset)
      templateVars = {
        userName: user.displayName, userEmail: user.email,
        assetName: transfer.booking.asset.name,
        startsAt: formatDate(transfer.booking.startsAt), endsAt: formatDate(transfer.booking.endsAt),
        bookingsUrl: `${env.APP_URL}/bookings`, appUrl: env.APP_URL,
      }
    }
  } else if (type === NotificationType.BOOKING_SWAP_REQUESTED && swapId) {
    const swap = await prisma.bookingSwap.findUnique({
      where: { id: swapId },
      include: { bookingA: { include: { asset: true } }, bookingB: true, initiator: true },
    })
    if (swap) {
      title = `Swap request — ${swap.bookingA.asset.name}`
      body = `${swap.initiator.displayName} wants to swap desks with you.`
      emailPayload = renderBookingSwapRequested(swap.bookingB, user, swap.initiator, swap.bookingA.asset)
      templateVars = {
        userName: user.displayName, userEmail: user.email,
        initiatorName: swap.initiator.displayName,
        assetName: swap.bookingA.asset.name,
        startsAt: formatDate(swap.bookingB.startsAt), endsAt: formatDate(swap.bookingB.endsAt),
        bookingsUrl: `${env.APP_URL}/bookings`, appUrl: env.APP_URL,
      }
    }
  } else if (type === NotificationType.BOOKING_SWAP_ACCEPTED && swapId) {
    const swap = await prisma.bookingSwap.findUnique({
      where: { id: swapId },
      include: { bookingA: { include: { asset: true } }, bookingB: { include: { asset: true } }, initiator: true, recipient: true },
    })
    if (swap) {
      // Each recipient of this notification is now on the *other* booking's
      // asset — this job fires once per party (see bookings.ts swap accept),
      // so work out which side `user` ended up on.
      const userEndsUpOnA = user.id === swap.recipientUserId
      const newBooking = userEndsUpOnA ? swap.bookingA : swap.bookingB
      const newAsset = userEndsUpOnA ? swap.bookingA.asset : swap.bookingB.asset
      const otherUser = userEndsUpOnA ? swap.initiator : swap.recipient
      title = `Swap complete — ${newAsset.name}`
      body = `Your desk swap with ${otherUser.displayName} is complete — you're now on ${newAsset.name}.`
      emailPayload = renderBookingSwapAccepted(newBooking, user, otherUser, newAsset)
      // This booking row's icsSequence was already bumped by the swap-accept
      // transaction (ownership changed, same reasoning as transfer above) —
      // a fresh REQUEST here is what actually puts the new desk on this
      // user's calendar. The desk they gave up is handled separately: see
      // the BOOKING_CANCELLED job bookings.ts enqueues alongside this one.
      icalEvent = {
        method: 'REQUEST',
        content: buildBookingIcs({
          id: newBooking.id, startsAt: newBooking.startsAt, endsAt: newBooking.endsAt,
          assetName: newAsset.name,
          sequence: newBooking.icsSequence,
          attendeeEmail: user.email, attendeeName: user.displayName,
        }, 'REQUEST'),
      }
      templateVars = {
        userName: user.displayName, userEmail: user.email,
        otherUserName: otherUser.displayName,
        assetName: newAsset.name,
        startsAt: formatDate(newBooking.startsAt), endsAt: formatDate(newBooking.endsAt),
        bookingsUrl: `${env.APP_URL}/bookings`, appUrl: env.APP_URL,
      }
    }
  } else if (type === NotificationType.BOOKING_SWAP_DECLINED && swapId) {
    const swap = await prisma.bookingSwap.findUnique({
      where: { id: swapId },
      include: { bookingA: { include: { asset: true } }, recipient: true },
    })
    if (swap) {
      title = `Swap declined — ${swap.bookingA.asset.name}`
      body = `${swap.recipient.displayName} declined your desk swap request.`
      emailPayload = renderBookingSwapDeclined(swap.bookingA, user, swap.recipient, swap.bookingA.asset)
      templateVars = {
        userName: user.displayName, userEmail: user.email,
        recipientName: swap.recipient.displayName,
        assetName: swap.bookingA.asset.name,
        startsAt: formatDate(swap.bookingA.startsAt), endsAt: formatDate(swap.bookingA.endsAt),
        bookingsUrl: `${env.APP_URL}/bookings`, appUrl: env.APP_URL,
      }
    }
  } else if (type === NotificationType.BOOKING_SWAP_EXPIRED && swapId) {
    const swap = await prisma.bookingSwap.findUnique({
      where: { id: swapId },
      include: { bookingA: { include: { asset: true } } },
    })
    if (swap) {
      title = `Swap request expired — ${swap.bookingA.asset.name}`
      body = `Nobody responded to your desk swap request in time — your booking is unchanged.`
      emailPayload = renderBookingSwapExpired(swap.bookingA, user, swap.bookingA.asset)
      templateVars = {
        userName: user.displayName, userEmail: user.email,
        assetName: swap.bookingA.asset.name,
        startsAt: formatDate(swap.bookingA.startsAt), endsAt: formatDate(swap.bookingA.endsAt),
        bookingsUrl: `${env.APP_URL}/bookings`, appUrl: env.APP_URL,
      }
    }
  } else if (type === NotificationType.MANAGER_REQUEST_SUBMITTED && managerRequestId) {
    const req = await prisma.floorManagerRequest.findUnique({
      where: { id: managerRequestId },
      include: { user: true, floor: { include: { building: true } } },
    })
    if (req) {
      const floorLabel = { name: req.floor.name, buildingName: req.floor.building.name }
      title = `Floor manager access request — ${req.floor.name}`
      body = `${req.user.displayName} has requested floor manager access to ${req.floor.name}.`
      emailPayload = renderManagerRequestSubmitted(user, req.user, floorLabel)
      templateVars = {
        userName: user.displayName, userEmail: user.email,
        requesterName: req.user.displayName, requesterEmail: req.user.email,
        floorName: req.floor.name, buildingName: req.floor.building.name,
        appUrl: env.APP_URL,
      }
    }
  } else if (type === NotificationType.MANAGER_REQUEST_APPROVED && managerRequestId) {
    const req = await prisma.floorManagerRequest.findUnique({
      where: { id: managerRequestId },
      include: { floor: { include: { building: true } } },
    })
    if (req) {
      const floorLabel = { name: req.floor.name, buildingName: req.floor.building.name }
      title = `Floor manager access approved — ${req.floor.name}`
      body = `You're now a floor manager for ${req.floor.name}.`
      emailPayload = renderManagerRequestApproved(user, floorLabel)
      templateVars = {
        userName: user.displayName, userEmail: user.email,
        floorName: req.floor.name, buildingName: req.floor.building.name,
        appUrl: env.APP_URL,
      }
    }
  } else if (type === NotificationType.MANAGER_REQUEST_REJECTED && managerRequestId) {
    const req = await prisma.floorManagerRequest.findUnique({
      where: { id: managerRequestId },
      include: { floor: { include: { building: true } } },
    })
    if (req) {
      const floorLabel = { name: req.floor.name, buildingName: req.floor.building.name }
      title = `Floor manager access declined — ${req.floor.name}`
      body = `Your request for floor manager access to ${req.floor.name} was declined.`
      emailPayload = renderManagerRequestRejected(user, floorLabel, req.reviewNote)
      templateVars = {
        userName: user.displayName, userEmail: user.email,
        floorName: req.floor.name, buildingName: req.floor.building.name,
        reviewNote: req.reviewNote ?? '',
        appUrl: env.APP_URL,
      }
    }
  } else if (type === NotificationType.MANAGER_REQUEST_EXPIRED && managerRequestId) {
    const req = await prisma.floorManagerRequest.findUnique({
      where: { id: managerRequestId },
      include: { floor: { include: { building: true } } },
    })
    if (req) {
      const floorLabel = { name: req.floor.name, buildingName: req.floor.building.name }
      title = `Floor manager access request expired — ${req.floor.name}`
      body = `Nobody reviewed your floor manager access request for ${req.floor.name} in time.`
      emailPayload = renderManagerRequestExpired(user, floorLabel)
      templateVars = {
        userName: user.displayName, userEmail: user.email,
        floorName: req.floor.name, buildingName: req.floor.building.name,
        appUrl: env.APP_URL,
      }
    }
  } else if (type === NotificationType.LEASE_EXPIRING && leaseId) {
    const lease = await prisma.buildingLease.findUnique({
      where: { id: leaseId },
      include: { building: { select: { name: true } } },
    })
    if (lease && lease.endDate) {
      const daysLeft = Math.max(0, Math.ceil((lease.endDate.getTime() - Date.now()) / (24 * 60 * 60 * 1000)))
      const leaseLabel = { name: lease.name, buildingName: lease.building.name, endDate: lease.endDate }
      title = `Lease expiring in ${daysLeft} day${daysLeft === 1 ? '' : 's'} — ${lease.building.name}`
      body = `The ${lease.name} lease for ${lease.building.name} expires ${formatDate(lease.endDate)}.`
      emailPayload = renderLeaseExpiring(user, leaseLabel, daysLeft)
      templateVars = {
        userName: user.displayName, userEmail: user.email,
        leaseName: lease.name, buildingName: lease.building.name,
        endDate: formatDate(lease.endDate), appUrl: env.APP_URL,
      }
    }
  } else if (type === NotificationType.LEASE_EXPIRED && leaseId) {
    const lease = await prisma.buildingLease.findUnique({
      where: { id: leaseId },
      include: { building: { select: { name: true } } },
    })
    if (lease && lease.endDate) {
      const leaseLabel = { name: lease.name, buildingName: lease.building.name, endDate: lease.endDate }
      title = `Lease expired — ${lease.building.name}`
      body = `The ${lease.name} lease for ${lease.building.name} expired ${formatDate(lease.endDate)}.`
      emailPayload = renderLeaseExpired(user, leaseLabel)
      templateVars = {
        userName: user.displayName, userEmail: user.email,
        leaseName: lease.name, buildingName: lease.building.name,
        endDate: formatDate(lease.endDate), appUrl: env.APP_URL,
      }
    }
  } else if (type === NotificationType.BOOKING_PENDING_APPROVAL && bookingId) {
    const booking = await prisma.booking.findUnique({
      where: { id: bookingId },
      include: { asset: { include: { floor: { select: { buildingId: true } } } }, user: true },
    })
    if (booking) {
      const tz = await resolveBuildingTimezone(prisma, booking.asset.floor?.buildingId)
      title = `Booking approval requested — ${booking.asset.name}`
      body = `${booking.user.displayName} has requested a booking for ${booking.asset.name} that needs your approval.`
      emailPayload = renderBookingPendingApproval(user, booking.user, booking, booking.asset, tz)
      templateVars = {
        userName: user.displayName, userEmail: user.email,
        requesterName: booking.user.displayName, requesterEmail: booking.user.email,
        assetName: booking.asset.name,
        startsAt: formatDate(booking.startsAt, tz), endsAt: formatDate(booking.endsAt, tz),
        bookingUrl: `${env.APP_URL}/admin/approvals`,
        appUrl: env.APP_URL,
      }
    }
  } else if (type === NotificationType.BOOKING_APPROVED && bookingId) {
    const booking = await prisma.booking.findUnique({
      where: { id: bookingId },
      include: { asset: { include: { primaryZone: { select: { name: true } }, floor: { select: { name: true, buildingId: true, building: { select: { name: true } } } } } } },
    })
    if (booking) {
      const tz = await resolveBuildingTimezone(prisma, booking.asset.floor?.buildingId)
      title = `Booking approved — ${booking.asset.name}`
      body = `Your booking for ${booking.asset.name} has been approved.`
      emailPayload = renderBookingApproved(user, booking, booking.asset, tz)
      icalEvent = {
        method: 'REQUEST',
        content: buildBookingIcs({
          id: booking.id, startsAt: booking.startsAt, endsAt: booking.endsAt,
          assetName: booking.asset.name,
          zoneName: booking.asset.primaryZone?.name,
          floorName: booking.asset.floor?.name,
          buildingName: booking.asset.floor?.building?.name,
          sequence: booking.icsSequence,
          attendeeEmail: user.email, attendeeName: user.displayName,
        }, 'REQUEST'),
      }
      templateVars = {
        userName: user.displayName, userEmail: user.email,
        assetName: booking.asset.name,
        startsAt: formatDate(booking.startsAt, tz), endsAt: formatDate(booking.endsAt, tz),
        bookingUrl: `${env.APP_URL}/bookings/${booking.id}`,
        appUrl: env.APP_URL,
      }
    }
  } else if (type === NotificationType.BOOKING_REJECTED && bookingId) {
    const booking = await prisma.booking.findUnique({
      where: { id: bookingId },
      include: { asset: { include: { floor: { select: { buildingId: true } } } } },
    })
    if (booking) {
      const tz = await resolveBuildingTimezone(prisma, booking.asset.floor?.buildingId)
      title = `Booking request declined — ${booking.asset.name}`
      body = `Your booking request for ${booking.asset.name} was declined.`
      emailPayload = renderBookingRejected(user, booking, booking.asset, booking.rejectionNote, tz)
      templateVars = {
        userName: user.displayName, userEmail: user.email,
        assetName: booking.asset.name,
        startsAt: formatDate(booking.startsAt, tz), endsAt: formatDate(booking.endsAt, tz),
        reviewNote: booking.rejectionNote ?? '',
        bookingsUrl: `${env.APP_URL}/bookings`, appUrl: env.APP_URL,
      }
    }
  } else if (type === NotificationType.BALLOT_WON && ballotEntryId) {
    const entry = await prisma.ballotEntry.findUnique({
      where: { id: ballotEntryId },
      include: { run: { include: { ballot: { select: { name: true } } } }, asset: { include: { floor: { select: { buildingId: true } } } }, booking: true },
    })
    if (entry?.asset && entry.booking) {
      const tz = await resolveBuildingTimezone(prisma, entry.asset.floor?.buildingId)
      title = `You won the ${entry.run.ballot.name} ballot — ${entry.asset.name}`
      body = `You've been randomly assigned ${entry.asset.name} from the ${entry.run.ballot.name} ballot.`
      emailPayload = renderBallotWon(user, entry.run.ballot.name, entry.asset, entry.booking, tz)
      templateVars = {
        userName: user.displayName, userEmail: user.email,
        ballotName: entry.run.ballot.name, assetName: entry.asset.name,
        startsAt: formatDate(entry.booking.startsAt, tz), endsAt: formatDate(entry.booking.endsAt, tz),
        bookingsUrl: `${env.APP_URL}/bookings`, appUrl: env.APP_URL,
      }
    }
  } else if (type === NotificationType.BALLOT_LOST && ballotEntryId) {
    const entry = await prisma.ballotEntry.findUnique({
      where: { id: ballotEntryId },
      include: { run: { include: { ballot: { select: { name: true } } } } },
    })
    if (entry) {
      title = `${entry.run.ballot.name} ballot results`
      body = `You weren't assigned an asset in this round of the ${entry.run.ballot.name} ballot.`
      emailPayload = renderBallotLost(user, entry.run.ballot.name)
      templateVars = {
        userName: user.displayName, userEmail: user.email,
        ballotName: entry.run.ballot.name, appUrl: env.APP_URL,
      }
    }
  } else if (type === NotificationType.WELCOME) {
    title = 'Welcome to Roomer'
    body = 'Your account has been created.'
    emailPayload = renderWelcome(user)
    templateVars = { userName: user.displayName, userEmail: user.email, appUrl: env.APP_URL }
  }

  // Apply custom email template if one is saved for this notification type
  if (emailPayload && Object.keys(templateVars).length > 0) {
    const org = await prisma.organisation.findFirst({ select: { emailTemplates: true } })
    const custom = ((org?.emailTemplates ?? {}) as Record<string, { subject: string; html: string } | undefined>)[type]
    if (custom) {
      const renderedHtml = interpolateTemplate(custom.html, templateVars)
      emailPayload = {
        subject: interpolateTemplate(custom.subject, templateVars),
        html: renderedHtml,
        text: stripHtmlToText(renderedHtml),
      }
    }
  }

  if (!title) {
    process.stderr.write(JSON.stringify({ level: 'warn', msg: '[queue] Unhandled notification type', type }) + '\n')
    return
  }

  // Respect per-user notification preferences. Missing key = all three channels enabled.
  type NotifPref = { email?: boolean; inApp?: boolean; push?: boolean }
  const prefs = (user as unknown as { notificationPreferences: Record<string, NotifPref> }).notificationPreferences ?? {}
  const pref: NotifPref = prefs[type] ?? {}
  const sendInApp = pref.inApp !== false
  const sendEmailNotif = pref.email !== false
  const sendPush = pref.push !== false && PUSH_ELIGIBLE_TYPES.has(type)

  // Persist in-app notification (if not opted out)
  if (sendInApp) {
    await prisma.notification.create({
      data: {
        userId,
        type,
        title,
        body,
        metadata: {
          bookingId: bookingId ?? null,
          queueEntryId: queueEntryId ?? null,
          // FLOOR_AVAILABLE's email deep-links to the floor plan
          // (floorUrl above), but the in-app bell had nothing to route to at
          // all since only bookingId/queueEntryId were ever persisted here —
          // clicking it silently did nothing.
          floorId: floorId ?? null,
          assetId: assetId ?? null,
          slotDate: slotDate ?? null,
        },
      },
    })
  }

  // Send email if we have a template and user hasn't opted out
  if (sendEmailNotif && emailPayload) {
    try {
      await sendEmail({ to: user.email, ...emailPayload, ...(icalEvent && { icalEvent }) })
    } catch (err) {
      process.stderr.write(JSON.stringify({ level: 'error', msg: '[queue] Failed to send email', to: user.email, err: String(err) }) + '\n')
      // Don't re-throw — notification is persisted, email failure is non-fatal
    }
  }

  // Push (if this type is push-eligible, user hasn't opted out, and VAPID is
  // configured — sendPushNotification no-ops otherwise). No try/catch here:
  // sendPushNotification already handles per-subscription failures
  // internally and never rejects.
  if (sendPush) {
    const url = PUSH_URL_KEYS.map((k) => templateVars[k]).find(Boolean) ?? env.APP_URL
    await sendPushNotification(userId, { title, body, url })
  }
}

// ─── Worker: expire-queue-entries (cron every 15 min) ────────────────────────

async function handleExpireQueueEntries(): Promise<void> {
  const now = new Date()
  const expired = await prisma.queueEntry.findMany({
    where: {
      status: 'WAITING',
      expiresAt: { lt: now },
    },
    select: { id: true, userId: true },
  })

  if (expired.length === 0) return

  // Re-check status right before mutating — expiresAt is a client-chosen
  // "give up waiting" time independent of the wanted window, so an entry can
  // still be a valid promotion candidate after it passes. If a slot frees up
  // (cancellation, no-show release, claim-deadline expiry) between the
  // findMany above and here, promoteNextQueueEntry could have already moved
  // this same entry to PROMOTED — an unconditional updateMany would stomp
  // that back to EXPIRED, leaving the user holding a "you've been promoted"
  // notification for an entry that's actually expired in the DB.
  const stillWaiting = await prisma.queueEntry.findMany({
    where: { id: { in: expired.map((e) => e.id) }, status: 'WAITING' },
    select: { id: true },
  })
  const stillWaitingIds = new Set(stillWaiting.map((e) => e.id))
  const toExpire = expired.filter((e) => stillWaitingIds.has(e.id))
  if (toExpire.length === 0) return

  await prisma.queueEntry.updateMany({
    where: { id: { in: toExpire.map((e) => e.id) } },
    data: { status: 'EXPIRED' },
  })

  const b = getBoss()
  await b.insert(
    'send-notification',
    toExpire.map((entry) => ({
      data: {
        type: NotificationType.QUEUE_EXPIRED,
        userId: entry.userId,
        queueEntryId: entry.id,
      } satisfies NotificationJobData,
    })),
  )

  await recordAuditLog(prisma, {
    actorId: null,
    action: 'queue_entry.expired_sweep',
    resourceType: 'QueueEntry',
    resourceId: randomUUID(),
    after: { expiredIds: toExpire.map((e) => e.id), count: toExpire.length },
  })

  process.stdout.write(JSON.stringify({ level: 'info', msg: '[queue] Expired queue entries', count: toExpire.length }) + '\n')
}

// ─── Worker: expire-transfer-requests (cron every 15 min) ────────────────────
// Auto-declines a pending BookingTransfer/BookingSwap nobody responded to in
// time — same "don't leave a request dangling forever" reasoning as
// expire-queue-entries above, reusing the org's queueClaimWindowHours as the
// response window (set at request-creation time in bookings.ts) rather than
// re-deriving it here.

async function handleExpireTransferRequests(): Promise<void> {
  const now = new Date()

  const expiredTransfers = await prisma.bookingTransfer.findMany({
    where: { status: 'PENDING', expiresAt: { lt: now } },
    select: { id: true, fromUserId: true },
  })
  if (expiredTransfers.length > 0) {
    // Atomic per-row conditional update — only rows still PENDING at the
    // moment this runs actually flip, so a transfer the recipient accepted/
    // declined (or the requester cancelled) in the race window between the
    // findMany above and here is left alone.
    await prisma.bookingTransfer.updateMany({
      where: { id: { in: expiredTransfers.map((t) => t.id) }, status: 'PENDING' },
      data: { status: 'EXPIRED', respondedAt: now },
    })
    // `count` alone doesn't say *which* rows the conditional update actually
    // matched — notifying/webhooking over the pre-recheck expiredTransfers
    // list would tell someone their transfer expired even if it was accepted/
    // declined/cancelled in the race window instead. Re-query for the subset
    // that's actually EXPIRED now, same toRelease/toExpire idiom no-show
    // release and queue-entry expiry use.
    const stillExpiredTransfers = await prisma.bookingTransfer.findMany({
      where: { id: { in: expiredTransfers.map((t) => t.id) }, status: 'EXPIRED' },
      select: { id: true, fromUserId: true },
    })
    if (stillExpiredTransfers.length > 0) {
      const b = getBoss()
      await b.insert(
        'send-notification',
        stillExpiredTransfers.map((t) => ({
          data: { type: NotificationType.BOOKING_TRANSFER_EXPIRED, userId: t.fromUserId, transferId: t.id } satisfies NotificationJobData,
        })),
      )
      for (const t of stillExpiredTransfers) {
        dispatchWebhook('booking.transfer_expired', { id: t.id }).catch(() => {})
      }
      await recordAuditLog(prisma, {
        actorId: null,
        action: 'booking_transfer.expired_sweep',
        resourceType: 'BookingTransfer',
        resourceId: randomUUID(),
        after: { expiredIds: stillExpiredTransfers.map((t) => t.id), count: stillExpiredTransfers.length },
      })
    }
  }

  const expiredSwaps = await prisma.bookingSwap.findMany({
    where: { status: 'PENDING', expiresAt: { lt: now } },
    select: { id: true, initiatorUserId: true },
  })
  if (expiredSwaps.length > 0) {
    await prisma.bookingSwap.updateMany({
      where: { id: { in: expiredSwaps.map((s) => s.id) }, status: 'PENDING' },
      data: { status: 'EXPIRED', respondedAt: now },
    })
    const stillExpiredSwaps = await prisma.bookingSwap.findMany({
      where: { id: { in: expiredSwaps.map((s) => s.id) }, status: 'EXPIRED' },
      select: { id: true, initiatorUserId: true },
    })
    if (stillExpiredSwaps.length > 0) {
      const b = getBoss()
      await b.insert(
        'send-notification',
        stillExpiredSwaps.map((s) => ({
          data: { type: NotificationType.BOOKING_SWAP_EXPIRED, userId: s.initiatorUserId, swapId: s.id } satisfies NotificationJobData,
        })),
      )
      for (const s of stillExpiredSwaps) {
        dispatchWebhook('booking.swap_expired', { id: s.id }).catch(() => {})
      }
      await recordAuditLog(prisma, {
        actorId: null,
        action: 'booking_swap.expired_sweep',
        resourceType: 'BookingSwap',
        resourceId: randomUUID(),
        after: { expiredIds: stillExpiredSwaps.map((s) => s.id), count: stillExpiredSwaps.length },
      })
    }
  }
}

// ─── Worker: expire-manager-requests (cron every 15 min) ─────────────────────
// Auto-closes a pending FloorManagerRequest nobody reviewed within
// MANAGER_REQUEST_EXPIRY_DAYS — same "don't leave a request dangling forever"
// reasoning as expire-transfer-requests above.

async function handleExpireManagerRequests(): Promise<void> {
  const now = new Date()

  const expired = await prisma.floorManagerRequest.findMany({
    where: { status: 'PENDING', expiresAt: { lt: now } },
    select: { id: true, userId: true },
  })
  if (expired.length === 0) return

  // Atomic per-row conditional update — only rows still PENDING at the
  // moment this runs actually flip, so a request approved/rejected/withdrawn
  // in the race window between the findMany above and here is left alone.
  await prisma.floorManagerRequest.updateMany({
    where: { id: { in: expired.map((r) => r.id) }, status: 'PENDING' },
    data: { status: 'EXPIRED' },
  })
  // Re-query for the subset actually EXPIRED now — a bare update count
  // doesn't say *which* rows flipped, and notifying over the pre-recheck
  // `expired` list would tell someone their request expired even if it was
  // approved/rejected/withdrawn in the race window instead.
  const stillExpired = await prisma.floorManagerRequest.findMany({
    where: { id: { in: expired.map((r) => r.id) }, status: 'EXPIRED' },
    select: { id: true, userId: true },
  })
  if (stillExpired.length === 0) return

  const b = getBoss()
  await b.insert(
    'send-notification',
    stillExpired.map((r) => ({
      data: { type: NotificationType.MANAGER_REQUEST_EXPIRED, userId: r.userId, managerRequestId: r.id } satisfies NotificationJobData,
    })),
  )
  for (const r of stillExpired) {
    dispatchWebhook('manager_request.expired', { id: r.id, userId: r.userId }).catch(() => {})
  }
  await recordAuditLog(prisma, {
    actorId: null,
    action: 'floor_manager_request.expired_sweep',
    resourceType: 'FloorManagerRequest',
    resourceId: randomUUID(),
    after: { expiredIds: stillExpired.map((r) => r.id), count: stillExpired.length },
  })
}

// ─── Worker: lease-expiry (cron daily) ────────────────────────────────────────
// Notifies (in-app/email/webhook) once a lease enters the same 90-day
// "expiring soon" window the admin UI's banner already uses (LeasesAdminPage
// computes this client-side; this is the same threshold, just also driving a
// real notification), and again once it actually expires. Each half is
// tracked by its own *NotifiedAt timestamp so a lease isn't re-notified every
// day it sits in the window — see #222.
async function handleLeaseExpiry(): Promise<void> {
  const now = new Date()
  const ninetyDaysOut = new Date(now.getTime() + 90 * 24 * 60 * 60 * 1000)

  const [expiringSoon, justExpired, superAdmins] = await Promise.all([
    prisma.buildingLease.findMany({
      where: { endDate: { gte: now, lte: ninetyDaysOut }, expiringNotifiedAt: null },
      include: { building: { select: { id: true, name: true } } },
    }),
    prisma.buildingLease.findMany({
      where: { endDate: { lt: now }, expiredNotifiedAt: null },
      include: { building: { select: { id: true, name: true } } },
    }),
    prisma.user.findMany({ where: { globalRole: 'SUPER_ADMIN', accountStatus: 'ACTIVE' }, select: { id: true } }),
  ])
  if (expiringSoon.length === 0 && justExpired.length === 0) return

  const superAdminIds = superAdmins.map((a) => a.id)
  const boss = getBoss()

  for (const lease of expiringSoon) {
    const buildingAdminIds = await getBuildingAdminUserIds(lease.buildingId)
    const recipientIds = [...new Set([...superAdminIds, ...buildingAdminIds])]
    if (recipientIds.length > 0) {
      await boss.insert(
        'send-notification',
        recipientIds.map((userId) => ({
          data: { type: NotificationType.LEASE_EXPIRING, userId, leaseId: lease.id } satisfies NotificationJobData,
        })),
      )
    }
    dispatchWebhook('lease.expiring', { id: lease.id, buildingId: lease.buildingId, buildingName: lease.building.name, endDate: lease.endDate?.toISOString() }).catch(() => {})
    await prisma.buildingLease.update({ where: { id: lease.id }, data: { expiringNotifiedAt: now } })
  }

  for (const lease of justExpired) {
    const buildingAdminIds = await getBuildingAdminUserIds(lease.buildingId)
    const recipientIds = [...new Set([...superAdminIds, ...buildingAdminIds])]
    if (recipientIds.length > 0) {
      await boss.insert(
        'send-notification',
        recipientIds.map((userId) => ({
          data: { type: NotificationType.LEASE_EXPIRED, userId, leaseId: lease.id } satisfies NotificationJobData,
        })),
      )
    }
    dispatchWebhook('lease.expired', { id: lease.id, buildingId: lease.buildingId, buildingName: lease.building.name, endDate: lease.endDate?.toISOString() }).catch(() => {})
    await prisma.buildingLease.update({ where: { id: lease.id }, data: { expiredNotifiedAt: now } })
  }
}

// ─── Worker: auto-complete-bookings (cron every 30 min) ──────────────────────

async function handleAutoCompleteBookings(): Promise<void> {
  const bookings = await prisma.booking.findMany({
    where: { status: 'CONFIRMED', endsAt: { lt: new Date() } },
    select: { id: true, userId: true, assetId: true, startsAt: true, endsAt: true },
  })
  if (bookings.length === 0) return

  await prisma.booking.updateMany({
    where: { id: { in: bookings.map((b) => b.id) } },
    data: { status: 'COMPLETED' },
  })

  for (const booking of bookings) {
    dispatchWebhook('booking.completed', booking).catch(() => {})
  }
  await recordAuditLog(prisma, {
    actorId: null,
    action: 'booking.auto_completed_sweep',
    resourceType: 'Booking',
    resourceId: randomUUID(),
    after: { completedIds: bookings.map((b) => b.id), count: bookings.length },
  })

  process.stdout.write(JSON.stringify({ level: 'info', msg: '[queue] Auto-completed past bookings', count: bookings.length }) + '\n')
}

// ─── Worker: release-no-shows (cron every 10 min) ────────────────────────────

async function handleReleaseNoShows(): Promise<void> {
  const org = await prisma.organisation.findFirst({
    select: { noShowReleaseEnabled: true, checkInGraceMinutes: true, qrCheckInMode: true },
  })
  if (!org) return
  const orgDefault = org.noShowReleaseEnabled

  const now = new Date()
  const cutoff = new Date(now.getTime() - org.checkInGraceMinutes * 60 * 1000)

  // Candidates: CONFIRMED, not checked in, grace elapsed since start, slot still
  // active. The booking's own user being a permanent assignee of the asset is
  // exempt — the assignee owns the desk and shouldn't have to check in. This
  // must be checked against the *booking's* user, not merely whether the asset
  // has any assignment at all: an assigned asset can still be booked by someone
  // else entirely (assertBookable allows a non-assignee to book a slot the
  // owner opened up via an availability window/weekly rule), and that borrowed
  // booking should still be subject to no-show release like any other — an
  // asset-level "has any assignment" check would wrongly exempt it too, leaving
  // a desk nobody showed up for stuck unavailable to the queue all day.
  // Effective enablement resolves per booking: floor override → building
  // override → org default.
  const candidates = await prisma.booking.findMany({
    where: {
      status: 'CONFIRMED',
      checkedInAt: null,
      startsAt: { lte: cutoff },
      endsAt: { gt: now },
    },
    select: {
      id: true, userId: true, assetId: true, startsAt: true, endsAt: true,
      asset: {
        select: {
          userAssignments: { select: { userId: true } },
          floor: {
            select: {
              noShowReleaseEnabled: true,
              qrCheckInMode: true,
              building: { select: { noShowReleaseEnabled: true, qrCheckInMode: true } },
            },
          },
        },
      },
    },
  })

  const noShows = candidates.filter((b) => {
    const isAssignee = b.asset.userAssignments.some((ua) => ua.userId === b.userId)
    if (isAssignee) return false
    const floorOverride = b.asset.floor?.noShowReleaseEnabled
    const buildingOverride = b.asset.floor?.building?.noShowReleaseEnabled
    const enabled = floorOverride ?? buildingOverride ?? orgDefault
    // A mandatory QR check-in with no release enforcement behind it would do
    // nothing — resolves the same floor → building → org order as
    // noShowReleaseEnabled itself, and forces release regardless of that
    // setting's own value once QR is mandatory for this booking's scope.
    const qrMode = b.asset.floor?.qrCheckInMode ?? b.asset.floor?.building?.qrCheckInMode ?? org.qrCheckInMode
    return enabled || qrMode === 'MANDATORY'
  })
  if (noShows.length === 0) return

  // Re-check the candidates' current state right before mutating — the
  // findMany above and this update aren't transactional, so a check-in (or a
  // reschedule/cancel) landing in the gap would otherwise still get counted:
  // not just wrongly cancelling a booking someone did show up for, but also
  // wrongly notifying/promoting the queue for a slot that's still
  // legitimately occupied by whoever just checked in.
  const stillNoShow = await prisma.booking.findMany({
    where: { id: { in: noShows.map((b) => b.id) }, status: 'CONFIRMED', checkedInAt: null },
    select: { id: true },
  })
  const stillNoShowIds = new Set(stillNoShow.map((b) => b.id))
  const toRelease = noShows.filter((b) => stillNoShowIds.has(b.id))
  if (toRelease.length === 0) return

  await prisma.booking.updateMany({
    where: { id: { in: toRelease.map((b) => b.id) } },
    data: { status: 'CANCELLED', noShow: true },
  })

  await getBoss().insert(
    'send-notification',
    toRelease.map((b) => ({
      data: { type: NotificationType.BOOKING_NO_SHOW, userId: b.userId, bookingId: b.id } satisfies NotificationJobData,
    })),
  )
  for (const b of toRelease) {
    dispatchWebhook('booking.no_show', { id: b.id, userId: b.userId, assetId: b.assetId }).catch(() => {})
  }

  // Free the desk: promote the next queued user for the slot, or fan out floor availability.
  for (const b of toRelease) {
    const next = await promoteNextQueueEntry(b.assetId, b.startsAt, b.endsAt)
    if (next) {
      await getBoss().insert('send-notification', [{
        data: { type: NotificationType.QUEUE_PROMOTED, userId: next.userId, queueEntryId: next.id, claimDeadline: next.claimDeadline.toISOString() } satisfies NotificationJobData,
      }])
      dispatchWebhook('queue.promoted', { id: next.id, userId: next.userId, assetId: next.assetId, claimDeadline: next.claimDeadline.toISOString() }).catch(() => {})
    } else {
      const asset = await prisma.asset.findUnique({ where: { id: b.assetId }, select: { floorId: true, primaryZoneId: true } })
      if (asset?.floorId) {
        const slotDate = b.startsAt.toISOString().slice(0, 10)
        await fanOutFloorAvailable(b.assetId, asset.floorId, asset.primaryZoneId, slotDate, b.userId).catch(() => {})
      }
    }
  }

  await recordAuditLog(prisma, {
    actorId: null,
    action: 'booking.no_show_released_sweep',
    resourceType: 'Booking',
    resourceId: randomUUID(),
    after: { releasedIds: toRelease.map((b) => b.id), count: toRelease.length },
  })

  process.stdout.write(JSON.stringify({ level: 'info', msg: '[queue] Released no-show bookings', count: toRelease.length }) + '\n')
}

// ─── Worker: expire-claim-deadlines (cron every 5 min) ───────────────────────

async function handleExpireClaimDeadlines(): Promise<void> {
  const now = new Date()

  // Find PROMOTED entries whose claimDeadline has passed
  const expiredPromoted = await prisma.queueEntry.findMany({
    where: {
      status: 'PROMOTED',
      claimDeadline: { lt: now },
    },
  })

  if (expiredPromoted.length === 0) return

  // Conditional on status: 'PROMOTED' — without this, a claim that commits
  // (routes/queue.ts POST /:id/claim-by-token, under lockAssetForBooking) in
  // the gap between the findMany above and this update would get silently
  // overwritten back to EXPIRED even though a real Booking now exists for
  // that user. That route's own comment documents expecting exactly this
  // guard on the cron side; only the count/rows this condition actually
  // matches are safe to notify/promote from below — not the stale
  // pre-recheck `expiredPromoted` list, which may include entries someone
  // just legitimately claimed.
  const stillExpired = await prisma.queueEntry.findMany({
    where: { id: { in: expiredPromoted.map((e) => e.id) }, status: 'PROMOTED' },
  })
  if (stillExpired.length === 0) return

  await prisma.queueEntry.updateMany({
    where: { id: { in: stillExpired.map((e) => e.id) }, status: 'PROMOTED' },
    data: { status: 'EXPIRED' },
  })

  // Tell the user who missed their claim window — every other queue-entry
  // transition (join, promote, expire-while-waiting) notifies the affected
  // user; this one previously only fired a webhook, leaving the person who
  // lost their slot with no email or in-app notice at all.
  await getBoss().insert(
    'send-notification',
    stillExpired.map((entry) => ({
      data: {
        type: NotificationType.QUEUE_EXPIRED,
        userId: entry.userId,
        queueEntryId: entry.id,
      } satisfies NotificationJobData,
    })),
  )

  for (const entry of stillExpired) {
    dispatchWebhook('queue.expired', { id: entry.id, userId: entry.userId, assetId: entry.assetId }).catch(() => {})
  }

  // Promote the next WAITING entry for each expired slot. Each promotion takes
  // the per-asset queue lock and re-reads under it, so when two expired entries
  // share an asset (e.g. adjacent sub-ranges expiring in the same sweep) the
  // second promotion correctly sees the first's WAITING->PROMOTED transition
  // instead of both racing to promote the same "next" entry.
  const toPromote = (
    await Promise.all(
      stillExpired.map((entry) => promoteNextQueueEntry(entry.assetId, entry.wantedStartsAt, entry.wantedEndsAt)),
    )
  ).filter((e): e is NonNullable<typeof e> => e !== null)

  if (toPromote.length > 0) {
    await getBoss().insert(
      'send-notification',
      toPromote.map((nextEntry) => ({
        data: {
          type: NotificationType.QUEUE_PROMOTED,
          userId: nextEntry.userId,
          queueEntryId: nextEntry.id,
          claimDeadline: nextEntry.claimDeadline.toISOString(),
        } satisfies NotificationJobData,
      })),
    )

    for (const nextEntry of toPromote) {
      dispatchWebhook('queue.promoted', { id: nextEntry.id, userId: nextEntry.userId, assetId: nextEntry.assetId, claimDeadline: nextEntry.claimDeadline.toISOString() }).catch(() => {})
    }
  }

  await recordAuditLog(prisma, {
    actorId: null,
    action: 'queue_entry.claim_expired_sweep',
    resourceType: 'QueueEntry',
    resourceId: randomUUID(),
    after: { expiredIds: stillExpired.map((e) => e.id), count: stillExpired.length },
  })

  process.stdout.write(JSON.stringify({ level: 'info', msg: '[queue] Processed expired claim deadlines', count: expiredPromoted.length }) + '\n')
}

// ─── Worker: auto-reject-pending-approvals (cron every 15 min, see #74) ──────

/**
 * Auto-rejects any PENDING_APPROVAL booking whose approvalExpiresAt has
 * passed — nobody reviewed it in time, so the requester shouldn't be left
 * holding an indefinitely-pending slot. Mirrors handleExpireClaimDeadlines's
 * TOCTOU-safe re-check: a booking can be approved/rejected by a human (POST
 * /bookings/:id/approve|reject) in the gap between the findMany below and
 * the update, so only rows still PENDING_APPROVAL at update time are
 * touched — an unconditional updateMany could otherwise stomp a booking a
 * reviewer just approved back to CANCELLED.
 */
async function handleAutoRejectPendingApprovals(): Promise<void> {
  const now = new Date()

  const expired = await prisma.booking.findMany({
    where: { status: 'PENDING_APPROVAL', approvalExpiresAt: { lt: now } },
    select: { id: true, userId: true, assetId: true, startsAt: true, endsAt: true, recurringRuleId: true },
  })
  if (expired.length === 0) return

  const stillPending = await prisma.booking.findMany({
    where: { id: { in: expired.map((b) => b.id) }, status: 'PENDING_APPROVAL' },
    select: { id: true, userId: true, assetId: true, startsAt: true, endsAt: true, recurringRuleId: true },
  })
  if (stillPending.length === 0) return

  const AUTO_REJECT_NOTE = 'Auto-rejected: no response within the approval window'

  const claimed = await prisma.booking.updateMany({
    where: { id: { in: stillPending.map((b) => b.id) }, status: 'PENDING_APPROVAL' },
    data: { status: 'CANCELLED', rejectionNote: AUTO_REJECT_NOTE, approvalExpiresAt: null },
  })
  if (claimed.count === 0) return

  // The guarded updateMany above already correctly skips a booking a human
  // just approved/rejected in the gap between the stillPending read and this
  // write — but everything below this point must act on exactly the rows it
  // actually touched, not the (potentially stale) stillPending snapshot.
  // Without this, that same race lets a booking a human just approved get a
  // spurious "cancelled" webhook, a contradictory BOOKING_REJECTED
  // notification, and promoteNextQueueEntry attempting to hand its
  // still-occupied slot to the next queue entrant.
  const actuallyRejected = claimed.count === stillPending.length
    ? stillPending
    : await prisma.booking.findMany({
        where: { id: { in: stillPending.map((b) => b.id) }, status: 'CANCELLED', rejectionNote: AUTO_REJECT_NOTE },
        select: { id: true, userId: true, assetId: true, startsAt: true, endsAt: true, recurringRuleId: true },
      })

  // A recurring series' occurrences all share the same approvalExpiresAt (set
  // once at creation — see POST /recurring-bookings), so a whole rule expires
  // together in the same sweep. Mark it CANCELLED the same way a manual
  // reject does (POST /bookings/:id/reject), rather than leaving it ACTIVE
  // with zero bookings and no obvious reason why.
  const ruleIds = [...new Set(actuallyRejected.map((b) => b.recurringRuleId).filter((v): v is string => !!v))]
  if (ruleIds.length > 0) {
    await prisma.recurringBookingRule.updateMany({
      where: { id: { in: ruleIds }, status: { not: 'CANCELLED' } },
      data: { status: 'CANCELLED' },
    })
  }

  for (const b of actuallyRejected) {
    dispatchWebhook('booking.cancelled', { id: b.id, userId: b.userId, assetId: b.assetId }).catch(() => {})
  }

  // One BOOKING_REJECTED per requester per series (not per occurrence) —
  // same dedup reasoning as the manual reject endpoint. A single sweep can
  // catch several independent series/standalone bookings at once, so group
  // by recurringRuleId (falling back to the booking's own id when standalone)
  // and notify once per group, referencing its earliest occurrence.
  const groups = new Map<string, typeof actuallyRejected>()
  for (const b of actuallyRejected) {
    const key = b.recurringRuleId ?? `single:${b.id}`
    const group = groups.get(key)
    if (group) group.push(b)
    else groups.set(key, [b])
  }
  for (const group of groups.values()) {
    group.sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime())
    await enqueueNotification({
      type: NotificationType.BOOKING_REJECTED,
      userId: group[0].userId,
      bookingId: group[0].id,
    })
  }

  // Release each freed slot — promote the next queued entry and fan out to
  // floor subscribers, same as any other booking cancellation.
  for (const b of actuallyRejected) {
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
    const asset = await prisma.asset.findUnique({ where: { id: b.assetId }, select: { floorId: true, primaryZoneId: true } })
    if (asset?.floorId) {
      const slotDate = b.startsAt.toISOString().slice(0, 10)
      await fanOutFloorAvailable(b.assetId, asset.floorId, asset.primaryZoneId, slotDate, b.userId)
        .catch((err) => process.stderr.write(JSON.stringify({ level: 'warn', msg: '[queue] floor fan-out error', err: String(err) }) + '\n'))
    }
  }

  await recordAuditLog(prisma, {
    actorId: null,
    action: 'booking.auto_rejected_sweep',
    resourceType: 'Booking',
    resourceId: randomUUID(),
    after: { rejectedIds: actuallyRejected.map((b) => b.id), count: actuallyRejected.length, note: AUTO_REJECT_NOTE },
  })

  process.stdout.write(JSON.stringify({ level: 'info', msg: '[queue] Auto-rejected expired pending-approval bookings', count: actuallyRejected.length }) + '\n')
}

// ─── Worker: send-booking-reminders (cron every 15 min) ──────────────────────

async function handleSendBookingReminders(): Promise<void> {
  const org = await prisma.organisation.findFirst({ select: { bookingReminderHours: true } })
  const reminderHours = org?.bookingReminderHours ?? 24
  const now = new Date()
  const windowEnd = new Date(now.getTime() + reminderHours * 60 * 60 * 1000)

  // Find confirmed bookings starting within the reminder window that haven't been reminded yet.
  // We claim them immediately (set reminderSentAt) before enqueuing to prevent double-sends
  // across overlapping cron invocations.
  const bookings = await prisma.booking.findMany({
    where: {
      status: 'CONFIRMED',
      startsAt: { gt: now, lte: windowEnd },
      reminderSentAt: null,
    },
    select: { id: true, userId: true },
  })

  if (bookings.length === 0) return

  await prisma.booking.updateMany({
    where: { id: { in: bookings.map((b) => b.id) }, reminderSentAt: null },
    data: { reminderSentAt: now },
  })

  const b = getBoss()
  await b.insert(
    'send-notification',
    bookings.map((booking) => ({
      data: {
        type: NotificationType.BOOKING_REMINDER,
        userId: booking.userId,
        bookingId: booking.id,
      } satisfies NotificationJobData,
    })),
  )

  process.stdout.write(JSON.stringify({ level: 'info', msg: '[queue] Enqueued booking reminders', count: bookings.length }) + '\n')
}

// ─── Worker: warn-claim-expiring (cron every 5 min) ──────────────────────────

/** How far ahead of the claim deadline to send the "closing soon" warning. */
const CLAIM_WARNING_WINDOW_MS = 30 * 60 * 1000 // 30 minutes

async function handleWarnClaimExpiring(): Promise<void> {
  const now = new Date()
  const windowEnd = new Date(now.getTime() + CLAIM_WARNING_WINDOW_MS)

  // Find PROMOTED entries whose claim deadline falls within the warning window
  // and haven't been warned yet. We claim them immediately (set
  // claimExpiryWarnedAt) before enqueuing to prevent double-sends across
  // overlapping cron invocations — same pattern as handleSendBookingReminders.
  const entries = await prisma.queueEntry.findMany({
    where: {
      status: 'PROMOTED',
      claimDeadline: { gt: now, lte: windowEnd },
      claimExpiryWarnedAt: null,
    },
    select: { id: true, userId: true, claimDeadline: true },
  })

  if (entries.length === 0) return

  await prisma.queueEntry.updateMany({
    where: { id: { in: entries.map((e) => e.id) }, claimExpiryWarnedAt: null },
    data: { claimExpiryWarnedAt: now },
  })

  await getBoss().insert(
    'send-notification',
    entries.map((entry) => ({
      data: {
        type: NotificationType.QUEUE_CLAIM_EXPIRING,
        userId: entry.userId,
        queueEntryId: entry.id,
        claimDeadline: entry.claimDeadline!.toISOString(),
      } satisfies NotificationJobData,
    })),
  )

  process.stdout.write(JSON.stringify({ level: 'info', msg: '[queue] Warned expiring claims', count: entries.length }) + '\n')
}

/**
 * Weekly utilisation digest for every active SUPER_ADMIN, gated on
 * Organisation.weeklyReportEnabled (opt-in — see #78). Org-wide, not scoped
 * to a building/floor, matching who it's for. Sent directly via sendEmail
 * rather than through enqueueNotification/NotificationType: this isn't a
 * per-user notification about the recipient's own bookings (the
 * notification-preferences system it would otherwise be gated by doesn't
 * apply to an operational digest tied to an org-level setting), and it has
 * no in-app/bell equivalent to record.
 */
async function handleSendWeeklyReport(): Promise<void> {
  const org = await prisma.organisation.findFirst({ select: { id: true, weeklyReportEnabled: true, lastWeeklyReportSentAt: true } })
  if (!org?.weeklyReportEnabled) return

  // Claim atomically before doing any work — guards against a duplicate send
  // if this job is retried after a crash or somehow fires twice in close
  // succession, same non-duplicate-send guarantee handleSendBookingReminders/
  // handleWarnClaimExpiring get from claiming their own per-row timestamp
  // before enqueueing. The cron fires weekly, so anything within the last 6
  // days is treated as "already sent this cycle" — a day of slack for the
  // scheduler's own timing jitter, without risking skipping a genuine week.
  const now = new Date()
  const notSentRecently = { OR: [{ lastWeeklyReportSentAt: null }, { lastWeeklyReportSentAt: { lt: new Date(now.getTime() - 6 * 24 * 60 * 60 * 1000) } }] }
  const claimed = await prisma.organisation.updateMany({
    where: { id: org.id, ...notSentRecently },
    data: { lastWeeklyReportSentAt: now },
  })
  if (claimed.count === 0) return

  // Resolved against the org's own default timezone (not a specific
  // building — this report is org-wide), same as any other org-level
  // timezone-sensitive calculation (see resolveBuildingTimezone). Without
  // this, the weekday classification below and the displayed date range
  // both silently used UTC regardless of the org's configured timezone —
  // for a non-UTC org, bookings made in the local evening near a day
  // boundary could land in the wrong side of the workingDays split, and the
  // emailed date range wouldn't match the local week the recipient expects.
  const tz = await resolveBuildingTimezone(prisma, null)

  const endDate = now
  const startDate = new Date(endDate.getTime() - 7 * 24 * 60 * 60 * 1000)
  let workingDays = 0
  const cursor = new Date(startDate)
  while (cursor <= endDate) {
    const d = toZonedTime(cursor, tz).getDay()
    if (d !== 0 && d !== 6) workingDays++
    cursor.setUTCDate(cursor.getUTCDate() + 1)
  }
  workingDays = workingDays || 1

  const bookingWhere = { startsAt: { gte: startDate, lte: endDate } }
  const [confirmed, cancelled, noShowCount, uniqueBookers, bookableDesks, assignedDesks] = await Promise.all([
    prisma.booking.count({ where: { ...bookingWhere, status: 'CONFIRMED' } }),
    prisma.booking.count({ where: { ...bookingWhere, status: 'CANCELLED' } }),
    prisma.booking.count({ where: { ...bookingWhere, status: 'CANCELLED', noShow: true } }),
    prisma.booking.findMany({
      where: { ...bookingWhere, status: { in: ['CONFIRMED', 'COMPLETED'] } },
      select: { userId: true },
      distinct: ['userId'],
    }),
    prisma.asset.count({ where: { isBookable: true, bookingStatus: { in: ['OPEN', 'RESTRICTED'] } } }),
    prisma.asset.count({ where: { isBookable: true, bookingStatus: 'ASSIGNED' } }),
  ])
  const manualCancelled = Math.max(0, cancelled - noShowCount)
  const activeDesks = bookableDesks + assignedDesks
  const totalCapacity = activeDesks * workingDays
  const overallUtilisationPct = totalCapacity > 0 ? Math.round((confirmed / totalCapacity) * 100) : 0
  const rangeLabel = `${formatDate(startDate, tz)} – ${formatDate(endDate, tz)}`

  const admins = await prisma.user.findMany({
    where: { globalRole: 'SUPER_ADMIN', accountStatus: 'ACTIVE' },
    select: { displayName: true, email: true },
  })
  if (admins.length === 0) return

  const stats = {
    rangeLabel,
    totalBookings: confirmed,
    cancelledBookings: manualCancelled,
    noShowBookings: noShowCount,
    uniqueBookers: uniqueBookers.length,
    overallUtilisationPct,
  }

  for (const admin of admins) {
    const { subject, html, text } = renderWeeklyReport(admin, stats)
    await sendEmail({ to: admin.email, subject, html, text }).catch((err) => {
      process.stderr.write(JSON.stringify({ level: 'error', msg: '[queue] Failed to send weekly report', email: admin.email, err: String(err) }) + '\n')
    })
  }

  process.stdout.write(JSON.stringify({ level: 'info', msg: '[queue] Sent weekly report', recipients: admins.length }) + '\n')
}

// ─── Start queue ──────────────────────────────────────────────────────────────

export async function startQueue(): Promise<void> {
  const b = getBoss()
  await b.start()

  // In pg-boss v10, queues must be created before they can be scheduled or worked
  await b.createQueue('send-notification')
  await b.createQueue('expire-queue-entries')
  await b.createQueue('expire-claim-deadlines')
  await b.createQueue('prune-revoked-tokens')
  await b.createQueue('auto-complete-bookings')
  await b.createQueue('send-booking-reminders')
  await b.createQueue('release-no-shows')
  await b.createQueue('warn-claim-expiring')
  await b.createQueue('webhook-delivery')
  await b.createQueue('send-weekly-report')
  await b.createQueue('expire-transfer-requests')
  await b.createQueue('expire-manager-requests')
  await b.createQueue('lease-expiry')
  await b.createQueue('auto-reject-pending-approvals')
  await b.createQueue('ballot-open-registration')
  await b.createQueue('ballot-draw')

  await b.work<NotificationJobData>('send-notification', handleSendNotification)

  const { deliverWebhookJob } = await import('./webhook.js')
  // includeMetadata exposes retryCount on each job so delivery attempts are logged accurately.
  // batchSize/localConcurrency default to 1 — a single slow-but-not-hanging
  // endpoint would otherwise serialize delivery to every OTHER endpoint's
  // events behind it in the same queue. 5 lets a handful of deliveries run
  // concurrently (this is I/O-bound outbound HTTP, not CPU work) without
  // needing per-tenant queue partitioning.
  //
  // perJobResults is required, not optional, at batchSize > 1: without it,
  // pg-boss settles the whole fetched batch as one unit off whether the
  // handler's single Promise resolves or rejects. deliverWebhookJob's own
  // loop already attempts every job regardless of an earlier one failing,
  // but with the plain (non-perJobResults) handler shape, one endpoint's
  // failure among the batch still failed/retried every OTHER job in it too
  // — including ones already delivered successfully earlier in the same
  // loop, causing a real duplicate delivery of an event that had already
  // succeeded. perJobResults settles each job by the individual outcome
  // deliverWebhookJob reports for it instead.
  await b.work('webhook-delivery', { includeMetadata: true, batchSize: 5, localConcurrency: 5, perJobResults: true }, deliverWebhookJob)

  await b.work('expire-queue-entries', async () => {
    await handleExpireQueueEntries()
  })
  await b.schedule('expire-queue-entries', '*/15 * * * *', {})

  await b.work('expire-transfer-requests', async () => {
    await handleExpireTransferRequests()
  })
  await b.schedule('expire-transfer-requests', '*/15 * * * *', {})

  await b.work('expire-manager-requests', async () => {
    await handleExpireManagerRequests()
  })
  await b.schedule('expire-manager-requests', '*/15 * * * *', {})

  await b.work('expire-claim-deadlines', async () => {
    await handleExpireClaimDeadlines()
  })
  await b.schedule('expire-claim-deadlines', '*/5 * * * *', {})

  await b.work('auto-complete-bookings', async () => {
    await handleAutoCompleteBookings()
  })
  await b.schedule('auto-complete-bookings', '*/30 * * * *', {})

  await b.work('release-no-shows', async () => {
    await handleReleaseNoShows()
  })
  await b.schedule('release-no-shows', '*/10 * * * *', {})

  // Prune expired JWT blocklist entries every 30 minutes
  await b.work('prune-revoked-tokens', async () => {
    await pruneExpiredBlocklistEntries()
  })
  await b.schedule('prune-revoked-tokens', '*/30 * * * *', {})

  await b.work('send-booking-reminders', async () => {
    await handleSendBookingReminders()
  })
  await b.schedule('send-booking-reminders', '*/15 * * * *', {})

  await b.work('warn-claim-expiring', async () => {
    await handleWarnClaimExpiring()
  })
  await b.schedule('warn-claim-expiring', '*/5 * * * *', {})

  // Monday 08:00 UTC — handleSendWeeklyReport itself no-ops when
  // weeklyReportEnabled is off, so this can stay unconditionally scheduled.
  await b.work('send-weekly-report', async () => {
    await handleSendWeeklyReport()
  })
  await b.schedule('send-weekly-report', '0 8 * * 1', {})

  // Daily 08:00 UTC — a 90-day-out threshold doesn't need faster polling.
  await b.work('lease-expiry', async () => {
    await handleLeaseExpiry()
  })
  await b.schedule('lease-expiry', '0 8 * * *', {})

  await b.work('auto-reject-pending-approvals', async () => {
    await handleAutoRejectPendingApprovals()
  })
  await b.schedule('auto-reject-pending-approvals', '*/15 * * * *', {})

  // See #159. Hourly is plenty for spawning a run days/weeks ahead of its
  // draw; the draw itself runs on the tighter 15-min cadence shared with
  // the other time-sensitive crons above.
  const { handleBallotOpenRegistration, handleBallotDraw } = await import('./ballot.js')
  await b.work('ballot-open-registration', async () => {
    await handleBallotOpenRegistration()
  })
  await b.schedule('ballot-open-registration', '0 * * * *', {})

  await b.work('ballot-draw', async () => {
    await handleBallotDraw()
  })
  await b.schedule('ballot-draw', '*/15 * * * *', {})

  process.stdout.write(JSON.stringify({ level: 'info', msg: '[queue] pg-boss started and workers registered' }) + '\n')
}

// ─── Enqueue helper ───────────────────────────────────────────────────────────

// Every call site in routes/ treats this as fire-and-forget — the primary
// mutation (booking created/cancelled/rescheduled, transfer accepted, queue
// claimed, etc.) has already committed by the time this runs, so a failure
// here must never surface as an error response for a request that actually
// succeeded. Two call sites (users.ts) already wrapped this in their own
// .catch(), which is the correct intent — but the other ~28 call sites across
// bookings/queue/recurring/assets awaited it unguarded, so a transient
// pg-boss/DB blip would throw past an already-committed transaction straight
// into Fastify's generic 500 handler, telling the client an operation that
// fully succeeded had failed. Catching here, once, guarantees that
// regardless of call site.
export async function enqueueNotification(data: NotificationJobData): Promise<void> {
  const b = getBoss()
  try {
    await b.send('send-notification', data)
  } catch (err) {
    process.stderr.write(JSON.stringify({ level: 'error', msg: '[queue] Failed to enqueue notification', type: data.type, err: String(err) }) + '\n')
  }
}

// ─── Floor-subscription fan-out ──────────────────────────────────────────────
// Called after a booking is cancelled or a desk is made available (action=none).
// Finds all subscribers for the floor/zone, applies a 30-min cooldown, and
// enqueues FLOOR_AVAILABLE notifications.

/** Advisory-lock class serialising the read-cooldown-check + write below, keyed
 * per floor. Distinct from ASSET_BOOKING_LOCK_CLASS (4242) / ASSET_QUEUE_LOCK_CLASS
 * (4243) / USER_BOOKING_QUOTA_LOCK_CLASS (4245) in lib/booking.ts, which are
 * keyed per asset/user, not per floor. pg_advisory_xact_lock's classid is one
 * global namespace, not scoped per-file — check lib/booking.ts before adding
 * another class number here. */
const FLOOR_NOTIFICATION_LOCK_CLASS = 4244

export async function fanOutFloorAvailable(
  assetId: string,
  floorId: string,
  primaryZoneId: string | null,
  slotDate: string,
  excludeUserId?: string,
): Promise<void> {
  const now = new Date()
  const cooldown = new Date(now.getTime() - 30 * 60000)

  // Two desks on the same floor can become available within milliseconds of
  // each other (e.g. the no-show-release sweep processing several bookings on
  // one floor). Without a lock, two concurrent calls both read the same set of
  // "not notified in the last 30 min" subscribers before either writes
  // lastNotifiedAt, and both send a FLOOR_AVAILABLE email — defeating the
  // cooldown's whole purpose. Locking per floor and re-reading under the lock
  // makes the second call see the first call's just-written lastNotifiedAt.
  const subscriptions = await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${FLOOR_NOTIFICATION_LOCK_CLASS}, hashtext(${floorId}))`

    const subs = await tx.floorSubscription.findMany({
      where: {
        floorId,
        ...(excludeUserId ? { userId: { not: excludeUserId } } : {}),
        OR: [
          { lastNotifiedAt: null },
          { lastNotifiedAt: { lt: cooldown } },
        ],
        AND: primaryZoneId
          ? [
              {
                OR: [
                  { zones: { none: {} } },
                  { zones: { some: { zoneId: primaryZoneId } } },
                ],
              },
            ]
          : [{ zones: { none: {} } }],
      },
      select: { id: true, userId: true },
    })

    if (subs.length > 0) {
      await tx.floorSubscription.updateMany({
        where: { id: { in: subs.map((s) => s.id) } },
        data: { lastNotifiedAt: now },
      })
    }

    return subs
  })

  if (subscriptions.length === 0) return

  await getBoss().insert(
    'send-notification',
    subscriptions.map((sub) => ({
      data: {
        type: NotificationType.FLOOR_AVAILABLE,
        userId: sub.userId,
        floorId,
        zoneId: primaryZoneId ?? undefined,
        assetId,
        slotDate,
      } satisfies NotificationJobData,
    })),
  )
}
