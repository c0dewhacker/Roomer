import { PgBoss, type Job } from 'pg-boss'
import { env } from '../env.js'
import { prisma } from './prisma.js'
import { sendEmail, renderBookingConfirmed, renderBookingCancelled, renderBookingReminder, renderQueueJoined, renderQueuePromoted, renderQueueExpired, renderWelcome, renderFloorAvailable, interpolateTemplate, stripHtmlToText, formatDate } from './mailer.js'
import { randomUUID } from 'crypto'
import { pruneExpiredBlocklistEntries } from './token-blocklist.js'
import { NotificationType } from '@roomer/shared'
import { dispatchWebhook } from './webhook.js'

let boss: PgBoss | null = null

export function getBoss(): PgBoss {
  if (!boss) {
    boss = new PgBoss(env.DATABASE_URL)
  }
  return boss
}

/** How long a promoted queue entry has to be claimed before it expires. */
export const CLAIM_DEADLINE_MS = 2 * 60 * 60 * 1000 // 2 hours

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
  const { type, userId, bookingId, queueEntryId, claimDeadline, floorId, zoneId, assetId, slotDate } = job.data

  const user = await prisma.user.findUnique({ where: { id: userId } })
  if (!user) {
    process.stderr.write(JSON.stringify({ level: 'warn', msg: '[queue] User not found for notification', userId }) + '\n')
    return
  }

  let title = ''
  let body = ''
  let emailPayload: { subject: string; html: string; text: string } | null = null
  let templateVars: Record<string, string> = {}

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
      templateVars = {
        userName: user.displayName, userEmail: user.email,
        assetName: booking.asset.name,
        zoneName: booking.asset.primaryZone?.name ?? '',
        floorName: booking.asset.floor?.name ?? '',
        startsAt: formatDate(booking.startsAt), endsAt: formatDate(booking.endsAt),
        notes: booking.notes ?? '',
        bookingUrl: `${env.APP_URL}/bookings/${booking.id}`,
        appUrl: env.APP_URL,
      }
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
      templateVars = {
        userName: user.displayName, userEmail: user.email,
        assetName: booking.asset.name,
        startsAt: formatDate(booking.startsAt), endsAt: formatDate(booking.endsAt),
        bookingsUrl: `${env.APP_URL}/bookings`, appUrl: env.APP_URL,
      }
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
      templateVars = {
        userName: user.displayName, userEmail: user.email,
        assetName: booking.asset.name,
        startsAt: formatDate(booking.startsAt), endsAt: formatDate(booking.endsAt),
        bookingsUrl: `${env.APP_URL}/bookings`, appUrl: env.APP_URL,
      }
    }
  } else if (type === NotificationType.BOOKING_REMINDER && bookingId) {
    const booking = await prisma.booking.findUnique({
      where: { id: bookingId },
      include: { asset: { include: { primaryZone: { select: { name: true } }, floor: { select: { name: true } } } } },
    })
    if (booking) {
      title = `Reminder — ${booking.asset.name} booking coming up`
      body = `Your booking starts at ${formatDate(booking.startsAt)}.`
      emailPayload = renderBookingReminder(booking, user, {
        name: booking.asset.name,
        zoneName: booking.asset.primaryZone?.name ?? '',
        floorName: booking.asset.floor?.name ?? '',
      })
      templateVars = {
        userName: user.displayName, userEmail: user.email,
        assetName: booking.asset.name,
        zoneName: booking.asset.primaryZone?.name ?? '',
        floorName: booking.asset.floor?.name ?? '',
        startsAt: formatDate(booking.startsAt), endsAt: formatDate(booking.endsAt),
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
      body = `Claim your booking by ${new Date(claimDeadline).toISOString()}.`
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

  // Respect per-user notification preferences. Missing key = both channels enabled.
  type NotifPref = { email?: boolean; inApp?: boolean }
  const prefs = (user as unknown as { notificationPreferences: Record<string, NotifPref> }).notificationPreferences ?? {}
  const pref: NotifPref = prefs[type] ?? {}
  const sendInApp = pref.inApp !== false
  const sendEmailNotif = pref.email !== false

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
        },
      },
    })
  }

  // Send email if we have a template and user hasn't opted out
  if (sendEmailNotif && emailPayload) {
    try {
      await sendEmail({ to: user.email, ...emailPayload })
    } catch (err) {
      process.stderr.write(JSON.stringify({ level: 'error', msg: '[queue] Failed to send email', to: user.email, err: String(err) }) + '\n')
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

  const b = getBoss()
  await b.insert(
    'send-notification',
    expired.map((entry) => ({
      data: {
        type: NotificationType.QUEUE_EXPIRED,
        userId: entry.userId,
        queueEntryId: entry.id,
      } satisfies NotificationJobData,
    })),
  )

  process.stdout.write(JSON.stringify({ level: 'info', msg: '[queue] Expired queue entries', count: expired.length }) + '\n')
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

  process.stdout.write(JSON.stringify({ level: 'info', msg: '[queue] Auto-completed past bookings', count: bookings.length }) + '\n')
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

  // Expire all in one batch
  await prisma.queueEntry.updateMany({
    where: { id: { in: expiredPromoted.map((e) => e.id) } },
    data: { status: 'EXPIRED' },
  })

  for (const entry of expiredPromoted) {
    dispatchWebhook('queue.expired', { id: entry.id, userId: entry.userId, assetId: entry.assetId }).catch(() => {})
  }

  // Find the next WAITING entry for each expired slot in parallel
  const claimDeadline = new Date(Date.now() + CLAIM_DEADLINE_MS)
  const nextEntries = await Promise.all(
    expiredPromoted.map((entry) =>
      prisma.queueEntry.findFirst({
        where: {
          assetId: entry.assetId,
          status: 'WAITING',
          wantedStartsAt: { lt: entry.wantedEndsAt },
          wantedEndsAt: { gt: entry.wantedStartsAt },
        },
        orderBy: { position: 'asc' },
      }),
    ),
  )

  const toPromote = nextEntries.filter((e): e is NonNullable<typeof e> => e !== null)

  if (toPromote.length > 0) {
    await Promise.all(
      toPromote.map((nextEntry) =>
        prisma.queueEntry.update({
          where: { id: nextEntry.id },
          data: { status: 'PROMOTED', claimDeadline, claimToken: randomUUID() },
        }),
      ),
    )

    await getBoss().insert(
      'send-notification',
      toPromote.map((nextEntry) => ({
        data: {
          type: NotificationType.QUEUE_PROMOTED,
          userId: nextEntry.userId,
          queueEntryId: nextEntry.id,
          claimDeadline: claimDeadline.toISOString(),
        } satisfies NotificationJobData,
      })),
    )

    for (const nextEntry of toPromote) {
      dispatchWebhook('queue.promoted', { id: nextEntry.id, userId: nextEntry.userId, assetId: nextEntry.assetId, claimDeadline: claimDeadline.toISOString() }).catch(() => {})
    }
  }

  process.stdout.write(JSON.stringify({ level: 'info', msg: '[queue] Processed expired claim deadlines', count: expiredPromoted.length }) + '\n')
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
  await b.createQueue('webhook-delivery')

  await b.work<NotificationJobData>('send-notification', handleSendNotification)

  const { deliverWebhookJob } = await import('./webhook.js')
  // includeMetadata exposes retryCount on each job so delivery attempts are logged accurately.
  await b.work('webhook-delivery', { includeMetadata: true }, deliverWebhookJob)

  await b.work('expire-queue-entries', async () => {
    await handleExpireQueueEntries()
  })
  await b.schedule('expire-queue-entries', '*/15 * * * *', {})

  await b.work('expire-claim-deadlines', async () => {
    await handleExpireClaimDeadlines()
  })
  await b.schedule('expire-claim-deadlines', '*/5 * * * *', {})

  await b.work('auto-complete-bookings', async () => {
    await handleAutoCompleteBookings()
  })
  await b.schedule('auto-complete-bookings', '*/30 * * * *', {})

  // Prune expired JWT blocklist entries every 30 minutes
  await b.work('prune-revoked-tokens', async () => {
    await pruneExpiredBlocklistEntries()
  })
  await b.schedule('prune-revoked-tokens', '*/30 * * * *', {})

  await b.work('send-booking-reminders', async () => {
    await handleSendBookingReminders()
  })
  await b.schedule('send-booking-reminders', '*/15 * * * *', {})

  process.stdout.write(JSON.stringify({ level: 'info', msg: '[queue] pg-boss started and workers registered' }) + '\n')
}

// ─── Enqueue helper ───────────────────────────────────────────────────────────

export async function enqueueNotification(data: NotificationJobData): Promise<void> {
  const b = getBoss()
  await b.send('send-notification', data)
}

// ─── Floor-subscription fan-out ──────────────────────────────────────────────
// Called after a booking is cancelled or a desk is made available (action=none).
// Finds all subscribers for the floor/zone, applies a 30-min cooldown, and
// enqueues FLOOR_AVAILABLE notifications.

export async function fanOutFloorAvailable(
  assetId: string,
  floorId: string,
  primaryZoneId: string | null,
  slotDate: string,
  excludeUserId?: string,
): Promise<void> {
  const now = new Date()
  const cooldown = new Date(now.getTime() - 30 * 60000)

  const subscriptions = await prisma.floorSubscription.findMany({
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

  if (subscriptions.length === 0) return

  await prisma.floorSubscription.updateMany({
    where: { id: { in: subscriptions.map((s) => s.id) } },
    data: { lastNotifiedAt: now },
  })

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
