import nodemailer from 'nodemailer'
import type { Transporter } from 'nodemailer'
import { env } from '../env'
import type { Booking, User, Asset, QueueEntry } from '@roomer/shared'

let transporter: Transporter | null = null

function getTransporter(): Transporter {
  if (!transporter) {
    transporter = nodemailer.createTransport({
      host: env.SMTP_HOST,
      port: env.SMTP_PORT,
      secure: env.SMTP_SECURE,
      auth:
        env.SMTP_USER && env.SMTP_PASS
          ? { user: env.SMTP_USER, pass: env.SMTP_PASS }
          : undefined,
    })
  }
  return transporter
}

interface SendEmailOptions {
  to: string
  subject: string
  html: string
  text: string
}

export async function sendEmail(opts: SendEmailOptions): Promise<void> {
  const t = getTransporter()
  await t.sendMail({
    from: env.EMAIL_FROM,
    to: opts.to,
    subject: opts.subject,
    html: opts.html,
    text: opts.text,
  })
}

// ─── Template helpers ─────────────────────────────────────────────────────────

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function formatDate(date: Date | string): string {
  return new Date(date).toLocaleString('en-GB', {
    weekday: 'short',
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

function baseHtml(title: string, body: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${title}</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #f4f4f5; margin: 0; padding: 20px; }
    .card { background: #fff; border-radius: 8px; max-width: 560px; margin: 0 auto; padding: 32px; }
    h1 { font-size: 22px; color: #18181b; margin-top: 0; }
    p { color: #52525b; line-height: 1.6; }
    .detail { background: #f4f4f5; border-radius: 6px; padding: 16px; margin: 16px 0; }
    .detail dt { font-size: 12px; color: #71717a; text-transform: uppercase; letter-spacing: 0.05em; }
    .detail dd { font-size: 15px; color: #18181b; margin: 2px 0 12px 0; font-weight: 500; }
    .btn { display: inline-block; background: #6366f1; color: #fff; padding: 12px 24px; border-radius: 6px; text-decoration: none; font-weight: 600; margin-top: 16px; }
    .footer { text-align: center; color: #a1a1aa; font-size: 12px; margin-top: 24px; }
  </style>
</head>
<body>
  <div class="card">
    ${body}
    <div class="footer">Roomer — Desk &amp; Asset Management</div>
  </div>
</body>
</html>`
}

// ─── BOOKING_CONFIRMED ────────────────────────────────────────────────────────

export function renderBookingConfirmed(
  booking: Pick<Booking, 'id' | 'startsAt' | 'endsAt' | 'notes'>,
  user: Pick<User, 'displayName' | 'email'>,
  asset: Pick<Asset, 'name'> & { zoneName?: string; floorName?: string },
): { subject: string; html: string; text: string } {
  const subject = `Booking confirmed — ${escapeHtml(asset.name)}`
  const safeUser = escapeHtml(user.displayName)
  const safeAsset = escapeHtml(asset.name)
  const safeZone = asset.zoneName ? escapeHtml(asset.zoneName) : ''
  const safeFloor = asset.floorName ? escapeHtml(asset.floorName) : ''
  const safeNotes = booking.notes ? escapeHtml(booking.notes) : ''
  const html = baseHtml(
    subject,
    `<h1>Your booking is confirmed</h1>
     <p>Hi ${safeUser}, your booking has been confirmed.</p>
     <div class="detail">
       <dl>
         <dt>Asset</dt><dd>${safeAsset}${safeZone ? ` — ${safeZone}` : ''}${safeFloor ? `, ${safeFloor}` : ''}</dd>
         <dt>From</dt><dd>${formatDate(booking.startsAt)}</dd>
         <dt>To</dt><dd>${formatDate(booking.endsAt)}</dd>
         ${safeNotes ? `<dt>Notes</dt><dd>${safeNotes}</dd>` : ''}
       </dl>
     </div>
     <a href="${env.APP_URL}/bookings/${booking.id}" class="btn">View Booking</a>`,
  )
  const text = `Hi ${user.displayName},\n\nYour booking for ${asset.name} has been confirmed.\nFrom: ${formatDate(booking.startsAt)}\nTo: ${formatDate(booking.endsAt)}\n\nView: ${env.APP_URL}/bookings/${booking.id}`
  return { subject, html, text }
}

// ─── BOOKING_CANCELLED ────────────────────────────────────────────────────────

export function renderBookingCancelled(
  booking: Pick<Booking, 'id' | 'startsAt' | 'endsAt'>,
  user: Pick<User, 'displayName' | 'email'>,
  asset: Pick<Asset, 'name'>,
): { subject: string; html: string; text: string } {
  const subject = `Booking cancelled — ${escapeHtml(asset.name)}`
  const html = baseHtml(
    subject,
    `<h1>Booking cancelled</h1>
     <p>Hi ${escapeHtml(user.displayName)}, your booking has been cancelled.</p>
     <div class="detail">
       <dl>
         <dt>Asset</dt><dd>${escapeHtml(asset.name)}</dd>
         <dt>Was scheduled</dt><dd>${formatDate(booking.startsAt)} → ${formatDate(booking.endsAt)}</dd>
       </dl>
     </div>
     <a href="${env.APP_URL}/bookings" class="btn">View My Bookings</a>`,
  )
  const text = `Hi ${user.displayName},\n\nYour booking for ${asset.name} (${formatDate(booking.startsAt)} → ${formatDate(booking.endsAt)}) has been cancelled.`
  return { subject, html, text }
}

// ─── QUEUE_JOINED ─────────────────────────────────────────────────────────────

export function renderQueueJoined(
  queueEntry: Pick<QueueEntry, 'id' | 'wantedStartsAt' | 'wantedEndsAt' | 'position'>,
  user: Pick<User, 'displayName' | 'email'>,
  asset: Pick<Asset, 'name'>,
): { subject: string; html: string; text: string } {
  const subject = `You've joined the queue — ${escapeHtml(asset.name)}`
  const html = baseHtml(
    subject,
    `<h1>You're in the queue</h1>
     <p>Hi ${escapeHtml(user.displayName)}, you have been added to the queue for <strong>${escapeHtml(asset.name)}</strong>.</p>
     <div class="detail">
       <dl>
         <dt>Position</dt><dd>#${queueEntry.position}</dd>
         <dt>Wanted period</dt><dd>${formatDate(queueEntry.wantedStartsAt)} → ${formatDate(queueEntry.wantedEndsAt)}</dd>
       </dl>
     </div>
     <p>We'll notify you immediately if the asset becomes available.</p>
     <a href="${env.APP_URL}/queue" class="btn">View My Queue</a>`,
  )
  const text = `Hi ${user.displayName},\n\nYou are #${queueEntry.position} in the queue for ${asset.name}.\nWanted: ${formatDate(queueEntry.wantedStartsAt)} → ${formatDate(queueEntry.wantedEndsAt)}\n\nWe'll notify you when the asset is available.\n\n${env.APP_URL}/queue`
  return { subject, html, text }
}

// ─── QUEUE_PROMOTED ───────────────────────────────────────────────────────────

export function renderQueuePromoted(
  queueEntry: Pick<QueueEntry, 'id' | 'wantedStartsAt' | 'wantedEndsAt'>,
  user: Pick<User, 'displayName' | 'email'>,
  asset: Pick<Asset, 'name'>,
  claimDeadline: Date,
): { subject: string; html: string; text: string } {
  const subject = `Asset available — claim now! ${escapeHtml(asset.name)}`
  const html = baseHtml(
    subject,
    `<h1>Your asset is available!</h1>
     <p>Hi ${escapeHtml(user.displayName)}, <strong>${escapeHtml(asset.name)}</strong> is now available for your requested period.</p>
     <div class="detail">
       <dl>
         <dt>Period</dt><dd>${formatDate(queueEntry.wantedStartsAt)} → ${formatDate(queueEntry.wantedEndsAt)}</dd>
         <dt>Claim by</dt><dd><strong>${formatDate(claimDeadline)}</strong></dd>
       </dl>
     </div>
     <p>You must claim this booking before the deadline or it will be offered to the next person in the queue.</p>
     <a href="${env.APP_URL}/queue" class="btn">Claim Now</a>`,
  )
  const text = `Hi ${user.displayName},\n\n${asset.name} is now available!\nPeriod: ${formatDate(queueEntry.wantedStartsAt)} → ${formatDate(queueEntry.wantedEndsAt)}\nClaim by: ${formatDate(claimDeadline)}\n\nClaim: ${env.APP_URL}/queue`
  return { subject, html, text }
}

// ─── QUEUE_EXPIRED ────────────────────────────────────────────────────────────

export function renderQueueExpired(
  queueEntry: Pick<QueueEntry, 'id' | 'wantedStartsAt' | 'wantedEndsAt'>,
  user: Pick<User, 'displayName' | 'email'>,
  asset: Pick<Asset, 'name'>,
): { subject: string; html: string; text: string } {
  const subject = `Queue entry expired — ${escapeHtml(asset.name)}`
  const html = baseHtml(
    subject,
    `<h1>Your queue entry has expired</h1>
     <p>Hi ${escapeHtml(user.displayName)}, your place in the queue for <strong>${escapeHtml(asset.name)}</strong> has expired without becoming available.</p>
     <div class="detail">
       <dl>
         <dt>Asset</dt><dd>${escapeHtml(asset.name)}</dd>
         <dt>Wanted period</dt><dd>${formatDate(queueEntry.wantedStartsAt)} → ${formatDate(queueEntry.wantedEndsAt)}</dd>
       </dl>
     </div>
     <p>You can rejoin the queue any time from the floor plan.</p>
     <a href="${env.APP_URL}/queue" class="btn">View My Queue</a>`,
  )
  const text = `Hi ${user.displayName},\n\nYour queue entry for ${asset.name} (${formatDate(queueEntry.wantedStartsAt)} → ${formatDate(queueEntry.wantedEndsAt)}) has expired.\n\nYou can rejoin the queue from the floor plan: ${env.APP_URL}`
  return { subject, html, text }
}

// ─── WELCOME ──────────────────────────────────────────────────────────────────

export function renderWelcome(
  user: Pick<User, 'displayName' | 'email'>,
): { subject: string; html: string; text: string } {
  const subject = 'Welcome to Roomer'
  const html = baseHtml(
    subject,
    `<h1>Welcome to Roomer!</h1>
     <p>Hi ${escapeHtml(user.displayName)}, your account has been created.</p>
     <p>Roomer lets you book hot-desks, manage your workspace and keep track of assets — all in one place.</p>
     <a href="${env.APP_URL}" class="btn">Get Started</a>`,
  )
  const text = `Hi ${user.displayName},\n\nWelcome to Roomer! Your account is ready.\n\nGet started: ${env.APP_URL}`
  return { subject, html, text }
}
