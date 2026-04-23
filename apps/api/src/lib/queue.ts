import PgBoss from 'pg-boss'
import { env } from '../env'
import { prisma } from './prisma'
import { sendEmail, renderBookingConfirmed, renderBookingCancelled, renderQueueJoined, renderQueuePromoted, renderQueueExpired, renderWelcome } from './mailer'
import { pruneExpiredBlocklistEntries } from './token-blocklist'
import { NotificationType } from '@roomer/shared'

let boss: PgBoss | null = null

export function getBoss(): PgBoss {
  if (!boss) {
    boss = new PgBoss(env.DATABASE_URL)
  }
  return boss
}

// ─── Notification job payload ─────────────────────────────────────────────────

export interface NotificationJobData {
  type: NotificationType
  userId: string
  bookingId?: string
  queueEntryId?: string
  claimDeadline?: string
}

// ─── Worker: send-notification ────────────────────────────────────────────────

async function handleSendNotification(
  jobs: PgBoss.Job<NotificationJobData>[],
): Promise<void> {
  for (const job of jobs) {
    await processSendNotification(job)
  }
}

async function processSendNotification(
  job: PgBoss.Job<NotificationJobData>,
): Promise<void> {
  const { type, userId, bookingId, queueEntryId, claimDeadline } = job.data

  const user = await prisma.user.findUnique({ where: { id: userId } })
  if (!user) {
    console.warn(`[queue] User not found for notification: ${userId}`)
    return
  }

  let title = ''
  let body = ''
  let emailPayload: { subject: string; html: string; text: string } | null = null

  if (type === NotificationType.BOOKING_CONFIRMED && bookingId) {
    const booking = await prisma.booking.findUnique({
      where: { id: bookingId },
      include: { asset: { include: { primaryZone: { select: { name: true } }, floor: { select: { name: true } } } } },
    })
    if (booking) {
      title = `Booking confirmed — ${booking.asset.name}`
      body = `Your booking for ${booking.asset.name} is confirmed from ${booking.startsAt.toISOString()} to ${booking.endsAt.toISOString()}`
      emailPayload = renderBookingConfirmed(booking, user, {
        name: booking.asset.name,
        zoneName: booking.asset.primaryZone?.name ?? '',
        floorName: booking.asset.floor?.name ?? '',
      })
    }
  } else if (type === NotificationType.BOOKING_CANCELLED && bookingId) {
    const booking = await prisma.booking.findUnique({
      where: { id: bookingId },
      include: { asset: true },
    })
    if (booking) {
      title = `Booking cancelled — ${booking.asset.name}`
      body = `Your booking for ${booking.asset.name} has been cancelled.`
      emailPayload = renderBookingCancelled(booking, user, booking.asset)
    }
  } else if (type === NotificationType.BOOKING_CANCELLED_BY_ADMIN && bookingId) {
    const booking = await prisma.booking.findUnique({
      where: { id: bookingId },
      include: { asset: true },
    })
    if (booking) {
      title = `Booking cancelled by admin — ${booking.asset.name}`
      body = `Your booking for ${booking.asset.name} has been cancelled by an administrator.`
      emailPayload = renderBookingCancelled(booking, user, booking.asset)
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
    }
  } else if (type === NotificationType.QUEUE_PROMOTED && queueEntryId) {
    const entry = await prisma.queueEntry.findUnique({
      where: { id: queueEntryId },
      include: { asset: true },
    })
    if (entry && claimDeadline) {
      title = `Asset available — ${entry.asset.name}`
      body = `Claim your booking by ${new Date(claimDeadline).toISOString()}.`
      emailPayload = renderQueuePromoted(entry, user, entry.asset, new Date(claimDeadline))
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
    }
  } else if (type === NotificationType.WELCOME) {
    title = 'Welcome to Roomer'
    body = 'Your account has been created.'
    emailPayload = renderWelcome(user)
  }

  if (!title) {
    console.warn(`[queue] Unhandled notification type: ${type}`)
    return
  }

  // Persist in-app notification
  await prisma.notification.create({
    data: {
      userId,
      type,
      title,
      body,
      metadata: {
        bookingId: bookingId ?? null,
        queueEntryId: queueEntryId ?? null,
      },
    },
  })

  // Send email if we have a template
  if (emailPayload) {
    try {
      await sendEmail({ to: user.email, ...emailPayload })
    } catch (err) {
      console.error(`[queue] Failed to send email to ${user.email}:`, err)
      // Don't re-throw — notification is persisted, email failure is non-fatal
    }
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

  await prisma.queueEntry.updateMany({
    where: { id: { in: expired.map((e) => e.id) } },
    data: { status: 'EXPIRED' },
  })

  // Notify each user
  const b = getBoss()
  for (const entry of expired) {
    await b.send('send-notification', {
      type: NotificationType.QUEUE_EXPIRED,
      userId: entry.userId,
      queueEntryId: entry.id,
    } satisfies NotificationJobData)
  }

  console.log(`[queue] Expired ${expired.length} queue entries`)
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

  for (const entry of expiredPromoted) {
    // Expire this entry
    await prisma.queueEntry.update({
      where: { id: entry.id },
      data: { status: 'EXPIRED' },
    })

    // Promote the next WAITING entry for this asset that overlaps the same slot
    const nextEntry = await prisma.queueEntry.findFirst({
      where: {
        assetId: entry.assetId,
        status: 'WAITING',
        wantedStartsAt: { lt: entry.wantedEndsAt },
        wantedEndsAt: { gt: entry.wantedStartsAt },
      },
      orderBy: { position: 'asc' },
    })

    if (nextEntry) {
      const claimDeadline = new Date(Date.now() + 2 * 60 * 60 * 1000) // +2h
      await prisma.queueEntry.update({
        where: { id: nextEntry.id },
        data: { status: 'PROMOTED', claimDeadline },
      })

      const b = getBoss()
      await b.send('send-notification', {
        type: NotificationType.QUEUE_PROMOTED,
        userId: nextEntry.userId,
        queueEntryId: nextEntry.id,
        claimDeadline: claimDeadline.toISOString(),
      } satisfies NotificationJobData)
    }
  }

  console.log(`[queue] Processed ${expiredPromoted.length} expired claim deadlines`)
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

  await b.work<NotificationJobData>('send-notification', handleSendNotification)

  await b.work('expire-queue-entries', async () => {
    await handleExpireQueueEntries()
  })
  await b.schedule('expire-queue-entries', '*/15 * * * *', {})

  await b.work('expire-claim-deadlines', async () => {
    await handleExpireClaimDeadlines()
  })
  await b.schedule('expire-claim-deadlines', '*/5 * * * *', {})

  // Prune expired JWT blocklist entries every 30 minutes
  await b.work('prune-revoked-tokens', async () => {
    await pruneExpiredBlocklistEntries()
  })
  await b.schedule('prune-revoked-tokens', '*/30 * * * *', {})

  console.log('[queue] pg-boss started and workers registered')
}

// ─── Enqueue helper ───────────────────────────────────────────────────────────

export async function enqueueNotification(data: NotificationJobData): Promise<void> {
  const b = getBoss()
  await b.send('send-notification', data)
}
