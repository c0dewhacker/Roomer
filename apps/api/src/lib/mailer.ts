import nodemailer from 'nodemailer'
import type { Transporter } from 'nodemailer'
import { env } from '../env.js'
import { getEffectiveSmtp } from './smtp-config.js'
import type { Booking, User, Asset, QueueEntry } from '@roomer/shared'

let transporter: Transporter | null = null
let cachedFrom: string | null = null

async function getTransporter(): Promise<{ transporter: Transporter; from: string }> {
  if (!transporter) {
    const cfg = await getEffectiveSmtp()
    transporter = nodemailer.createTransport({
      host: cfg.host,
      port: cfg.port,
      secure: cfg.secure,
      auth: cfg.user && cfg.pass ? { user: cfg.user, pass: cfg.pass } : undefined,
    })
    cachedFrom = cfg.from
  }
  return { transporter, from: cachedFrom ?? 'noreply@roomer.local' }
}

/** Drop the cached transporter so the next send re-resolves config (call after a settings change). */
export function resetMailer(): void {
  transporter = null
  cachedFrom = null
}

interface SendEmailOptions {
  to: string
  subject: string
  html: string
  text: string
  /** Optional calendar invite/cancellation attached as a text/calendar part. */
  icalEvent?: { method: string; filename?: string; content: string }
}

export async function sendEmail(opts: SendEmailOptions): Promise<void> {
  const { transporter: t, from } = await getTransporter()
  await t.sendMail({
    from,
    to: opts.to,
    subject: opts.subject,
    html: opts.html,
    text: opts.text,
    ...(opts.icalEvent && {
      icalEvent: {
        method: opts.icalEvent.method,
        filename: opts.icalEvent.filename ?? 'invite.ics',
        content: opts.icalEvent.content,
      },
    }),
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

/**
 * `timeZone` is a booking's resolved building timezone (see #72) — when the
 * caller has one (every booking-related email does, via queue.ts), the
 * email now shows the booking's actual building-local time instead of an
 * arbitrary UTC pin, matching how the web app renders the same booking
 * (apps/web/src/lib/utils.ts's formatDate, given the same resolved
 * timezone). Explicitly labelled either way (UTC or the zone's short name,
 * e.g. AEST) so it's never ambiguous which clock a shown time belongs to.
 * Falls back to UTC for the handful of non-booking emails (leases, manager
 * requests) that have no per-instance building association plumbed
 * through yet.
 */
export function formatDate(date: Date | string, timeZone = 'UTC'): string {
  const d = new Date(date)
  const formatted = d.toLocaleString('en-GB', {
    weekday: 'short',
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZone,
  })
  const zoneLabel = new Intl.DateTimeFormat('en', { timeZone, timeZoneName: 'short' })
    .formatToParts(d)
    .find((p) => p.type === 'timeZoneName')?.value ?? timeZone
  return `${formatted} ${zoneLabel}`
}

function baseHtml(title: string, body: string): string {
  // title is the plain-text subject line (also sent verbatim as the SMTP
  // Subject header and interpolated raw into the `text` fallback below) —
  // it must be escaped here, not by the caller, since every render*()
  // function builds it from raw user-controlled strings (displayName,
  // asset/floor/building name, ballot name). Escaping it a second time at
  // the call site (as every one of them used to, before this fix) would
  // double-escape it into the visible subject line instead — this is the
  // one place it's rendered as HTML, so this is the one place it should be
  // escaped.
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${escapeHtml(title)}</title>
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

// ─── Custom template interpolation ────────────────────────────────────────────

const URL_VARS = new Set(['bookingUrl', 'bookingsUrl', 'queueUrl', 'claimUrl', 'floorUrl', 'appUrl'])

export function interpolateTemplate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key: string) => {
    const val = vars[key] ?? ''
    return URL_VARS.has(key) ? val : escapeHtml(val)
  })
}

export function stripHtmlToText(html: string): string {
  return html
    .replace(/<[^>]*>/g, ' ')
    .replace(/[<>]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

// ─── Default parameterised template strings (shown in the editor as starting points) ──

export const DEFAULT_TEMPLATE_STRINGS: Record<string, { subject: string; html: string }> = {
  BOOKING_CONFIRMED: {
    subject: 'Booking confirmed — {{assetName}}',
    html: baseHtml('Booking confirmed — {{assetName}}', `<h1>Your booking is confirmed</h1>
     <p>Hi {{userName}}, your booking has been confirmed.</p>
     <div class="detail">
       <dl>
         <dt>Asset</dt><dd>{{assetName}}</dd>
         <dt>Zone</dt><dd>{{zoneName}}</dd>
         <dt>Floor</dt><dd>{{floorName}}</dd>
         <dt>From</dt><dd>{{startsAt}}</dd>
         <dt>To</dt><dd>{{endsAt}}</dd>
         <dt>Notes</dt><dd>{{notes}}</dd>
       </dl>
     </div>
     <a href="{{bookingUrl}}" class="btn">View Booking</a>`),
  },

  BOOKING_CANCELLED: {
    subject: 'Booking cancelled — {{assetName}}',
    html: baseHtml('Booking cancelled — {{assetName}}', `<h1>Booking cancelled</h1>
     <p>Hi {{userName}}, your booking has been cancelled.</p>
     <div class="detail">
       <dl>
         <dt>Asset</dt><dd>{{assetName}}</dd>
         <dt>Was scheduled</dt><dd>{{startsAt}} → {{endsAt}}</dd>
       </dl>
     </div>
     <a href="{{bookingsUrl}}" class="btn">View My Bookings</a>`),
  },

  BOOKING_CANCELLED_BY_ADMIN: {
    subject: 'Booking cancelled by administrator — {{assetName}}',
    html: baseHtml('Booking cancelled by administrator — {{assetName}}', `<h1>Booking cancelled by administrator</h1>
     <p>Hi {{userName}}, your booking has been cancelled by an administrator.</p>
     <div class="detail">
       <dl>
         <dt>Asset</dt><dd>{{assetName}}</dd>
         <dt>Was scheduled</dt><dd>{{startsAt}} → {{endsAt}}</dd>
       </dl>
     </div>
     <a href="{{bookingsUrl}}" class="btn">View My Bookings</a>`),
  },

  BOOKING_NO_SHOW: {
    subject: 'Booking released — {{assetName}}',
    html: baseHtml('Booking released — {{assetName}}', `<h1>Booking released</h1>
     <p>Hi {{userName}}, your booking was released because you didn't check in.</p>
     <div class="detail">
       <dl>
         <dt>Asset</dt><dd>{{assetName}}</dd>
         <dt>Was scheduled</dt><dd>{{startsAt}} → {{endsAt}}</dd>
       </dl>
     </div>
     <a href="{{bookingsUrl}}" class="btn">View My Bookings</a>`),
  },

  QUEUE_JOINED: {
    subject: "You've joined the queue — {{assetName}}",
    html: baseHtml("You've joined the queue — {{assetName}}", `<h1>You're in the queue</h1>
     <p>Hi {{userName}}, you have been added to the queue for <strong>{{assetName}}</strong>.</p>
     <div class="detail">
       <dl>
         <dt>Position</dt><dd>#{{position}}</dd>
         <dt>Wanted period</dt><dd>{{wantedStartsAt}} → {{wantedEndsAt}}</dd>
       </dl>
     </div>
     <p>We'll notify you immediately if the asset becomes available.</p>
     <a href="{{queueUrl}}" class="btn">View My Queue</a>`),
  },

  QUEUE_PROMOTED: {
    subject: 'Asset available — claim now! {{assetName}}',
    html: baseHtml('Asset available — claim now! {{assetName}}', `<h1>Your asset is available!</h1>
     <p>Hi {{userName}}, <strong>{{assetName}}</strong> is now available for your requested period.</p>
     <div class="detail">
       <dl>
         <dt>Period</dt><dd>{{wantedStartsAt}} → {{wantedEndsAt}}</dd>
         <dt>Claim by</dt><dd><strong>{{claimDeadline}}</strong></dd>
       </dl>
     </div>
     <p>Click the button below to claim your booking instantly — no login required. This link expires when the claim deadline passes.</p>
     <a href="{{claimUrl}}" class="btn">Claim Now</a>`),
  },

  QUEUE_EXPIRED: {
    subject: 'Queue entry expired — {{assetName}}',
    html: baseHtml('Queue entry expired — {{assetName}}', `<h1>Your queue entry has expired</h1>
     <p>Hi {{userName}}, your place in the queue for <strong>{{assetName}}</strong> has expired without becoming available.</p>
     <div class="detail">
       <dl>
         <dt>Asset</dt><dd>{{assetName}}</dd>
         <dt>Wanted period</dt><dd>{{wantedStartsAt}} → {{wantedEndsAt}}</dd>
       </dl>
     </div>
     <p>You can rejoin the queue any time from the floor plan.</p>
     <a href="{{queueUrl}}" class="btn">View My Queue</a>`),
  },

  QUEUE_CLAIM_EXPIRING: {
    subject: 'Claim window closing soon — {{assetName}}',
    html: baseHtml('Claim window closing soon — {{assetName}}', `<h1>Your claim window is closing soon</h1>
     <p>Hi {{userName}}, you still have <strong>{{assetName}}</strong> reserved for you, but your claim window is about to expire.</p>
     <div class="detail">
       <dl>
         <dt>Period</dt><dd>{{wantedStartsAt}} → {{wantedEndsAt}}</dd>
         <dt>Claim by</dt><dd><strong>{{claimDeadline}}</strong></dd>
       </dl>
     </div>
     <p>Claim it now before it's offered to the next person in the queue.</p>
     <a href="{{claimUrl}}" class="btn">Claim Now</a>`),
  },

  FLOOR_AVAILABLE: {
    subject: 'Desk available — {{floorName}}',
    html: baseHtml('Desk available — {{floorName}}', `<h1>A desk just became available</h1>
     <p><strong>{{assetName}}</strong> on <strong>{{floorName}}</strong> is now free.</p>
     <div class="detail">
       <dl>
         <dt>Floor</dt><dd>{{floorName}}</dd>
         <dt>Zone</dt><dd>{{zoneName}}</dd>
         <dt>Date</dt><dd>{{slotDate}}</dd>
       </dl>
     </div>
     <p>Be the first to book it.</p>
     <a href="{{floorUrl}}" class="btn">View Floor Plan</a>`),
  },

  WELCOME: {
    subject: 'Welcome to Roomer',
    html: baseHtml('Welcome to Roomer', `<h1>Welcome to Roomer!</h1>
     <p>Hi {{userName}}, your account has been created.</p>
     <p>Roomer lets you book hot-desks, manage your workspace and keep track of assets — all in one place.</p>
     <a href="{{appUrl}}" class="btn">Get Started</a>`),
  },
}

// ─── BOOKING_CONFIRMED ────────────────────────────────────────────────────────

export function renderBookingConfirmed(
  booking: Pick<Booking, 'id' | 'startsAt' | 'endsAt' | 'notes'> & { guestName?: string | null },
  user: Pick<User, 'displayName' | 'email'>,
  asset: Pick<Asset, 'name'> & { zoneName?: string; floorName?: string },
  timeZone = 'UTC',
): { subject: string; html: string; text: string } {
  // A guest booking (see #79) is still confirmed to the host, not the guest
  // (who gets their own separate invite email) — naming the guest here just
  // distinguishes it from the host's own bookings at a glance.
  const guestSuffix = booking.guestName ? ` for ${booking.guestName}` : ''
  const subject = `Booking confirmed${guestSuffix} — ${asset.name}`
  const safeUser = escapeHtml(user.displayName)
  const safeAsset = escapeHtml(asset.name)
  const safeGuestSuffix = booking.guestName ? ` for ${escapeHtml(booking.guestName)}` : ''
  const safeZone = asset.zoneName ? escapeHtml(asset.zoneName) : ''
  const safeFloor = asset.floorName ? escapeHtml(asset.floorName) : ''
  const safeNotes = booking.notes ? escapeHtml(booking.notes) : ''
  const html = baseHtml(
    subject,
    `<h1>Your booking is confirmed</h1>
     <p>Hi ${safeUser}, your booking${safeGuestSuffix} has been confirmed.</p>
     <div class="detail">
       <dl>
         <dt>Asset</dt><dd>${safeAsset}${safeZone ? ` — ${safeZone}` : ''}${safeFloor ? `, ${safeFloor}` : ''}</dd>
         <dt>From</dt><dd>${formatDate(booking.startsAt, timeZone)}</dd>
         <dt>To</dt><dd>${formatDate(booking.endsAt, timeZone)}</dd>
         ${safeNotes ? `<dt>Notes</dt><dd>${safeNotes}</dd>` : ''}
       </dl>
     </div>
     <a href="${env.APP_URL}/bookings/${booking.id}" class="btn">View Booking</a>`,
  )
  const text = `Hi ${user.displayName},\n\nYour booking${guestSuffix} for ${asset.name} has been confirmed.\nFrom: ${formatDate(booking.startsAt, timeZone)}\nTo: ${formatDate(booking.endsAt, timeZone)}\n\nView: ${env.APP_URL}/bookings/${booking.id}`
  return { subject, html, text }
}

// ─── BOOKING_CANCELLED ────────────────────────────────────────────────────────

export function renderBookingCancelled(
  booking: Pick<Booking, 'id' | 'startsAt' | 'endsAt'>,
  user: Pick<User, 'displayName' | 'email'>,
  asset: Pick<Asset, 'name'>,
  timeZone = 'UTC',
): { subject: string; html: string; text: string } {
  const subject = `Booking cancelled — ${asset.name}`
  const html = baseHtml(
    subject,
    `<h1>Booking cancelled</h1>
     <p>Hi ${escapeHtml(user.displayName)}, your booking has been cancelled.</p>
     <div class="detail">
       <dl>
         <dt>Asset</dt><dd>${escapeHtml(asset.name)}</dd>
         <dt>Was scheduled</dt><dd>${formatDate(booking.startsAt, timeZone)} → ${formatDate(booking.endsAt, timeZone)}</dd>
       </dl>
     </div>
     <a href="${env.APP_URL}/bookings" class="btn">View My Bookings</a>`,
  )
  const text = `Hi ${user.displayName},\n\nYour booking for ${asset.name} (${formatDate(booking.startsAt, timeZone)} → ${formatDate(booking.endsAt, timeZone)}) has been cancelled.`
  return { subject, html, text }
}

// ─── BOOKING_CANCELLED_BY_ADMIN ───────────────────────────────────────────────
// The admin template editor's "default" preview (DEFAULT_TEMPLATE_STRINGS
// above) has always had distinct "cancelled by an administrator" copy, but
// the actual send path called the plain renderBookingCancelled() above —
// recipients got an email indistinguishable from a self-cancellation, and it
// disagreed with the in-app notification for the same event. This mirrors
// DEFAULT_TEMPLATE_STRINGS.BOOKING_CANCELLED_BY_ADMIN so what's shown as the
// default in the template editor is what's actually sent.

export function renderBookingCancelledByAdmin(
  booking: Pick<Booking, 'id' | 'startsAt' | 'endsAt'>,
  user: Pick<User, 'displayName' | 'email'>,
  asset: Pick<Asset, 'name'>,
  timeZone = 'UTC',
): { subject: string; html: string; text: string } {
  const subject = `Booking cancelled by administrator — ${asset.name}`
  const html = baseHtml(
    subject,
    `<h1>Booking cancelled by administrator</h1>
     <p>Hi ${escapeHtml(user.displayName)}, your booking has been cancelled by an administrator.</p>
     <div class="detail">
       <dl>
         <dt>Asset</dt><dd>${escapeHtml(asset.name)}</dd>
         <dt>Was scheduled</dt><dd>${formatDate(booking.startsAt, timeZone)} → ${formatDate(booking.endsAt, timeZone)}</dd>
       </dl>
     </div>
     <a href="${env.APP_URL}/bookings" class="btn">View My Bookings</a>`,
  )
  const text = `Hi ${user.displayName},\n\nYour booking for ${asset.name} (${formatDate(booking.startsAt, timeZone)} → ${formatDate(booking.endsAt, timeZone)}) has been cancelled by an administrator.`
  return { subject, html, text }
}

// ─── BOOKING_NO_SHOW ──────────────────────────────────────────────────────────
// Previously reused renderBookingCancelled() too, and BOOKING_NO_SHOW wasn't
// even in the admin-editable template list — a released no-show user got an
// email that looked exactly like they'd cancelled themselves, with no
// indication their desk was released for missing check-in, and no way for
// an admin to fix the wording since it wasn't exposed to customize.

export function renderBookingNoShow(
  booking: Pick<Booking, 'id' | 'startsAt' | 'endsAt'>,
  user: Pick<User, 'displayName' | 'email'>,
  asset: Pick<Asset, 'name'>,
  timeZone = 'UTC',
): { subject: string; html: string; text: string } {
  const subject = `Booking released — ${asset.name}`
  const html = baseHtml(
    subject,
    `<h1>Booking released</h1>
     <p>Hi ${escapeHtml(user.displayName)}, your booking was released because you didn't check in.</p>
     <div class="detail">
       <dl>
         <dt>Asset</dt><dd>${escapeHtml(asset.name)}</dd>
         <dt>Was scheduled</dt><dd>${formatDate(booking.startsAt, timeZone)} → ${formatDate(booking.endsAt, timeZone)}</dd>
       </dl>
     </div>
     <a href="${env.APP_URL}/bookings" class="btn">View My Bookings</a>`,
  )
  const text = `Hi ${user.displayName},\n\nYour booking for ${asset.name} (${formatDate(booking.startsAt, timeZone)} → ${formatDate(booking.endsAt, timeZone)}) was released because you didn't check in.`
  return { subject, html, text }
}

// ─── QUEUE_JOINED ─────────────────────────────────────────────────────────────

export function renderQueueJoined(
  queueEntry: Pick<QueueEntry, 'id' | 'wantedStartsAt' | 'wantedEndsAt' | 'position'>,
  user: Pick<User, 'displayName' | 'email'>,
  asset: Pick<Asset, 'name'>,
): { subject: string; html: string; text: string } {
  const subject = `You've joined the queue — ${asset.name}`
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
  claimToken: string,
): { subject: string; html: string; text: string } {
  const claimUrl = `${env.APP_URL}/queue/claim?token=${encodeURIComponent(claimToken)}`
  const subject = `Asset available — claim now! ${asset.name}`
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
     <p>Click the button below to claim your booking instantly — no login required. This link expires when the claim deadline passes.</p>
     <a href="${claimUrl}" class="btn">Claim Now</a>`,
  )
  const text = `Hi ${user.displayName},\n\n${asset.name} is now available!\nPeriod: ${formatDate(queueEntry.wantedStartsAt)} → ${formatDate(queueEntry.wantedEndsAt)}\nClaim by: ${formatDate(claimDeadline)}\n\nClaim your booking: ${claimUrl}`
  return { subject, html, text }
}

// ─── QUEUE_CLAIM_EXPIRING ─────────────────────────────────────────────────────

export function renderQueueClaimExpiring(
  queueEntry: Pick<QueueEntry, 'id' | 'wantedStartsAt' | 'wantedEndsAt'>,
  user: Pick<User, 'displayName' | 'email'>,
  asset: Pick<Asset, 'name'>,
  claimDeadline: Date,
  claimToken: string,
): { subject: string; html: string; text: string } {
  const claimUrl = `${env.APP_URL}/queue/claim?token=${encodeURIComponent(claimToken)}`
  const subject = `Claim window closing soon — ${asset.name}`
  const html = baseHtml(
    subject,
    `<h1>Your claim window is closing soon</h1>
     <p>Hi ${escapeHtml(user.displayName)}, you still have <strong>${escapeHtml(asset.name)}</strong> reserved for you, but your claim window is about to expire.</p>
     <div class="detail">
       <dl>
         <dt>Period</dt><dd>${formatDate(queueEntry.wantedStartsAt)} → ${formatDate(queueEntry.wantedEndsAt)}</dd>
         <dt>Claim by</dt><dd><strong>${formatDate(claimDeadline)}</strong></dd>
       </dl>
     </div>
     <p>Claim it now before it's offered to the next person in the queue.</p>
     <a href="${claimUrl}" class="btn">Claim Now</a>`,
  )
  const text = `Hi ${user.displayName},\n\nYour claim window for ${asset.name} is closing soon.\nPeriod: ${formatDate(queueEntry.wantedStartsAt)} → ${formatDate(queueEntry.wantedEndsAt)}\nClaim by: ${formatDate(claimDeadline)}\n\nClaim your booking: ${claimUrl}`
  return { subject, html, text }
}

// ─── FLOOR_AVAILABLE ──────────────────────────────────────────────────────────

export function renderFloorAvailable(
  floor: { id: string; name: string },
  zone: { name: string } | null,
  asset: Pick<Asset, 'name'>,
  slotDate: string,
): { subject: string; html: string; text: string } {
  const floorUrl = `${env.APP_URL}/floors/${floor.id}?date=${slotDate}`
  const location = zone ? `${escapeHtml(floor.name)} · ${escapeHtml(zone.name)}` : escapeHtml(floor.name)
  const subject = `Desk available — ${location}`
  const html = baseHtml(
    subject,
    `<h1>A desk just became available</h1>
     <p><strong>${escapeHtml(asset.name)}</strong> on <strong>${location}</strong> is now free.</p>
     <div class="detail">
       <dl>
         <dt>Floor</dt><dd>${escapeHtml(floor.name)}</dd>
         ${zone ? `<dt>Zone</dt><dd>${escapeHtml(zone.name)}</dd>` : ''}
         <dt>Date</dt><dd>${slotDate}</dd>
       </dl>
     </div>
     <p>Be the first to book it.</p>
     <a href="${floorUrl}" class="btn">View Floor Plan</a>`,
  )
  const text = `A desk just became available on ${floor.name}${zone ? ` (${zone.name})` : ''}.\n\n${asset.name} is now free on ${slotDate}.\n\nView floor plan: ${floorUrl}`
  return { subject, html, text }
}

// ─── QUEUE_EXPIRED ────────────────────────────────────────────────────────────

export function renderQueueExpired(
  queueEntry: Pick<QueueEntry, 'id' | 'wantedStartsAt' | 'wantedEndsAt'>,
  user: Pick<User, 'displayName' | 'email'>,
  asset: Pick<Asset, 'name'>,
): { subject: string; html: string; text: string } {
  const subject = `Queue entry expired — ${asset.name}`
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

// ─── ASSET_ASSIGNED ───────────────────────────────────────────────────────────

export function renderAssetAssigned(
  assignment: { assignedAt: Date; notes: string | null },
  user: Pick<User, 'displayName' | 'email'>,
  asset: Pick<Asset, 'name'>,
): { subject: string; html: string; text: string } {
  const subject = `Asset assigned to you — ${asset.name}`
  const safeNotes = assignment.notes ? escapeHtml(assignment.notes) : ''
  const html = baseHtml(
    subject,
    `<h1>An asset has been assigned to you</h1>
     <p>Hi ${escapeHtml(user.displayName)}, <strong>${escapeHtml(asset.name)}</strong> has been assigned to you.</p>
     <div class="detail">
       <dl>
         <dt>Asset</dt><dd>${escapeHtml(asset.name)}</dd>
         <dt>Assigned</dt><dd>${formatDate(assignment.assignedAt)}</dd>
         ${safeNotes ? `<dt>Notes</dt><dd>${safeNotes}</dd>` : ''}
       </dl>
     </div>
     <a href="${env.APP_URL}/assets" class="btn">View My Assets</a>`,
  )
  const text = `Hi ${user.displayName},\n\n${asset.name} has been assigned to you (${formatDate(assignment.assignedAt)}).${assignment.notes ? `\nNotes: ${assignment.notes}` : ''}\n\nView: ${env.APP_URL}/assets`
  return { subject, html, text }
}

// ─── WELCOME ──────────────────────────────────────────────────────────────────

export function renderBookingReminder(
  booking: Pick<Booking, 'id' | 'startsAt' | 'endsAt'>,
  user: Pick<User, 'displayName' | 'email'>,
  asset: Pick<Asset, 'name'> & { zoneName?: string; floorName?: string },
  timeZone = 'UTC',
): { subject: string; html: string; text: string } {
  const subject = `Reminder — ${asset.name} booking coming up`
  const safeUser = escapeHtml(user.displayName)
  const safeAsset = escapeHtml(asset.name)
  const safeZone = asset.zoneName ? escapeHtml(asset.zoneName) : ''
  const safeFloor = asset.floorName ? escapeHtml(asset.floorName) : ''
  const html = baseHtml(
    subject,
    `<h1>Upcoming booking reminder</h1>
     <p>Hi ${safeUser}, your booking is coming up soon.</p>
     <div class="detail">
       <dl>
         <dt>Asset</dt><dd>${safeAsset}${safeZone ? ` — ${safeZone}` : ''}${safeFloor ? `, ${safeFloor}` : ''}</dd>
         <dt>Starts</dt><dd>${formatDate(booking.startsAt, timeZone)}</dd>
         <dt>Ends</dt><dd>${formatDate(booking.endsAt, timeZone)}</dd>
       </dl>
     </div>
     <a href="${env.APP_URL}/bookings/${booking.id}" class="btn">View Booking</a>`,
  )
  const text = `Hi ${user.displayName},\n\nReminder: your booking for ${asset.name} starts at ${formatDate(booking.startsAt, timeZone)}.\n\nView: ${env.APP_URL}/bookings/${booking.id}`
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

// ─── WEEKLY_REPORT ────────────────────────────────────────────────────────────

export interface WeeklyReportStats {
  rangeLabel: string
  totalBookings: number
  cancelledBookings: number
  noShowBookings: number
  uniqueBookers: number
  overallUtilisationPct: number
}

export function renderWeeklyReport(
  user: Pick<User, 'displayName' | 'email'>,
  stats: WeeklyReportStats,
): { subject: string; html: string; text: string } {
  const subject = `Weekly utilisation summary — ${stats.rangeLabel}`
  const safeUser = escapeHtml(user.displayName)
  const html = baseHtml(
    subject,
    `<h1>Weekly utilisation summary</h1>
     <p>Hi ${safeUser}, here's how desk booking looked for ${escapeHtml(stats.rangeLabel)}.</p>
     <div class="detail">
       <dl>
         <dt>Overall utilisation</dt><dd>${stats.overallUtilisationPct}%</dd>
         <dt>Confirmed bookings</dt><dd>${stats.totalBookings}</dd>
         <dt>Unique bookers</dt><dd>${stats.uniqueBookers}</dd>
         <dt>Cancelled bookings</dt><dd>${stats.cancelledBookings}</dd>
         <dt>No-shows</dt><dd>${stats.noShowBookings}</dd>
       </dl>
     </div>
     <a href="${env.APP_URL}/admin/reports" class="btn">View Full Report</a>
     <p style="font-size:12px;color:#a1a1aa;margin-top:24px;">You're receiving this because weekly report emails are enabled for your organisation. Turn them off in Settings.</p>`,
  )
  const text = `Hi ${user.displayName},\n\nWeekly utilisation summary — ${stats.rangeLabel}\n\nOverall utilisation: ${stats.overallUtilisationPct}%\nConfirmed bookings: ${stats.totalBookings}\nUnique bookers: ${stats.uniqueBookers}\nCancelled bookings: ${stats.cancelledBookings}\nNo-shows: ${stats.noShowBookings}\n\nFull report: ${env.APP_URL}/admin/reports`
  return { subject, html, text }
}

// ─── BOOKING_TRANSFER_* / BOOKING_SWAP_* (see #83) ─────────────────────────────

export function renderBookingTransferRequested(
  booking: Pick<Booking, 'startsAt' | 'endsAt'>,
  toUser: Pick<User, 'displayName'>,
  fromUser: Pick<User, 'displayName'>,
  asset: Pick<Asset, 'name'>,
): { subject: string; html: string; text: string } {
  const subject = `${fromUser.displayName} wants to transfer a booking to you — ${asset.name}`
  const html = baseHtml(
    subject,
    `<h1>Booking transfer request</h1>
     <p>Hi ${escapeHtml(toUser.displayName)}, ${escapeHtml(fromUser.displayName)} wants to hand you their booking.</p>
     <div class="detail">
       <dl>
         <dt>Asset</dt><dd>${escapeHtml(asset.name)}</dd>
         <dt>When</dt><dd>${formatDate(booking.startsAt)} → ${formatDate(booking.endsAt)}</dd>
       </dl>
     </div>
     <a href="${env.APP_URL}/bookings" class="btn">Review Request</a>`,
  )
  const text = `Hi ${toUser.displayName},\n\n${fromUser.displayName} wants to transfer their booking for ${asset.name} (${formatDate(booking.startsAt)} → ${formatDate(booking.endsAt)}) to you. Review it at ${env.APP_URL}/bookings`
  return { subject, html, text }
}

export function renderBookingTransferAccepted(
  booking: Pick<Booking, 'startsAt' | 'endsAt'>,
  fromUser: Pick<User, 'displayName'>,
  toUser: Pick<User, 'displayName'>,
  asset: Pick<Asset, 'name'>,
): { subject: string; html: string; text: string } {
  const subject = `${toUser.displayName} accepted your transfer — ${asset.name}`
  const html = baseHtml(
    subject,
    `<h1>Transfer accepted</h1>
     <p>Hi ${escapeHtml(fromUser.displayName)}, ${escapeHtml(toUser.displayName)} accepted your booking transfer. They now have this booking — it's no longer on your calendar.</p>
     <div class="detail">
       <dl>
         <dt>Asset</dt><dd>${escapeHtml(asset.name)}</dd>
         <dt>Was scheduled</dt><dd>${formatDate(booking.startsAt)} → ${formatDate(booking.endsAt)}</dd>
       </dl>
     </div>
     <a href="${env.APP_URL}/bookings" class="btn">View My Bookings</a>`,
  )
  const text = `Hi ${fromUser.displayName},\n\n${toUser.displayName} accepted your transfer of the ${asset.name} booking (${formatDate(booking.startsAt)} → ${formatDate(booking.endsAt)}). It's no longer on your calendar.`
  return { subject, html, text }
}

export function renderBookingTransferDeclined(
  booking: Pick<Booking, 'startsAt' | 'endsAt'>,
  fromUser: Pick<User, 'displayName'>,
  toUser: Pick<User, 'displayName'>,
  asset: Pick<Asset, 'name'>,
): { subject: string; html: string; text: string } {
  const subject = `${toUser.displayName} declined your transfer — ${asset.name}`
  const html = baseHtml(
    subject,
    `<h1>Transfer declined</h1>
     <p>Hi ${escapeHtml(fromUser.displayName)}, ${escapeHtml(toUser.displayName)} declined your booking transfer. It's still yours.</p>
     <div class="detail">
       <dl>
         <dt>Asset</dt><dd>${escapeHtml(asset.name)}</dd>
         <dt>When</dt><dd>${formatDate(booking.startsAt)} → ${formatDate(booking.endsAt)}</dd>
       </dl>
     </div>
     <a href="${env.APP_URL}/bookings" class="btn">View My Bookings</a>`,
  )
  const text = `Hi ${fromUser.displayName},\n\n${toUser.displayName} declined your transfer of the ${asset.name} booking (${formatDate(booking.startsAt)} → ${formatDate(booking.endsAt)}). It's still yours.`
  return { subject, html, text }
}

export function renderBookingTransferExpired(
  booking: Pick<Booking, 'startsAt' | 'endsAt'>,
  fromUser: Pick<User, 'displayName'>,
  asset: Pick<Asset, 'name'>,
): { subject: string; html: string; text: string } {
  const subject = `Your transfer request expired — ${asset.name}`
  const html = baseHtml(
    subject,
    `<h1>Transfer request expired</h1>
     <p>Hi ${escapeHtml(fromUser.displayName)}, nobody responded to your booking transfer in time, so it's still yours.</p>
     <div class="detail">
       <dl>
         <dt>Asset</dt><dd>${escapeHtml(asset.name)}</dd>
         <dt>When</dt><dd>${formatDate(booking.startsAt)} → ${formatDate(booking.endsAt)}</dd>
       </dl>
     </div>
     <a href="${env.APP_URL}/bookings" class="btn">View My Bookings</a>`,
  )
  const text = `Hi ${fromUser.displayName},\n\nNobody responded to your transfer request for the ${asset.name} booking (${formatDate(booking.startsAt)} → ${formatDate(booking.endsAt)}) in time, so it's still yours.`
  return { subject, html, text }
}

export function renderBookingSwapRequested(
  bookingB: Pick<Booking, 'startsAt' | 'endsAt'>,
  recipient: Pick<User, 'displayName'>,
  initiator: Pick<User, 'displayName'>,
  assetA: Pick<Asset, 'name'>,
): { subject: string; html: string; text: string } {
  const subject = `${initiator.displayName} wants to swap desks with you — ${assetA.name}`
  const html = baseHtml(
    subject,
    `<h1>Desk swap request</h1>
     <p>Hi ${escapeHtml(recipient.displayName)}, ${escapeHtml(initiator.displayName)} would like to swap their booking for yours.</p>
     <div class="detail">
       <dl>
         <dt>You'd get</dt><dd>${escapeHtml(assetA.name)}</dd>
         <dt>When</dt><dd>${formatDate(bookingB.startsAt)} → ${formatDate(bookingB.endsAt)}</dd>
       </dl>
     </div>
     <a href="${env.APP_URL}/bookings" class="btn">Review Request</a>`,
  )
  const text = `Hi ${recipient.displayName},\n\n${initiator.displayName} would like to swap their booking for ${assetA.name} (${formatDate(bookingB.startsAt)} → ${formatDate(bookingB.endsAt)}) with yours. Review it at ${env.APP_URL}/bookings`
  return { subject, html, text }
}

export function renderBookingSwapAccepted(
  newBooking: Pick<Booking, 'startsAt' | 'endsAt'>,
  user: Pick<User, 'displayName'>,
  otherUser: Pick<User, 'displayName'>,
  newAsset: Pick<Asset, 'name'>,
): { subject: string; html: string; text: string } {
  const subject = `Desk swap complete — you're now on ${newAsset.name}`
  const html = baseHtml(
    subject,
    `<h1>Swap complete</h1>
     <p>Hi ${escapeHtml(user.displayName)}, your desk swap with ${escapeHtml(otherUser.displayName)} is complete.</p>
     <div class="detail">
       <dl>
         <dt>You're now on</dt><dd>${escapeHtml(newAsset.name)}</dd>
         <dt>When</dt><dd>${formatDate(newBooking.startsAt)} → ${formatDate(newBooking.endsAt)}</dd>
       </dl>
     </div>
     <a href="${env.APP_URL}/bookings" class="btn">View My Bookings</a>`,
  )
  const text = `Hi ${user.displayName},\n\nYour desk swap with ${otherUser.displayName} is complete. You're now on ${newAsset.name} (${formatDate(newBooking.startsAt)} → ${formatDate(newBooking.endsAt)}).`
  return { subject, html, text }
}

export function renderBookingSwapDeclined(
  bookingA: Pick<Booking, 'startsAt' | 'endsAt'>,
  initiator: Pick<User, 'displayName'>,
  recipient: Pick<User, 'displayName'>,
  assetA: Pick<Asset, 'name'>,
): { subject: string; html: string; text: string } {
  const subject = `${recipient.displayName} declined your swap request — ${assetA.name}`
  const html = baseHtml(
    subject,
    `<h1>Swap declined</h1>
     <p>Hi ${escapeHtml(initiator.displayName)}, ${escapeHtml(recipient.displayName)} declined your desk swap request. Your booking is unchanged.</p>
     <div class="detail">
       <dl>
         <dt>Asset</dt><dd>${escapeHtml(assetA.name)}</dd>
         <dt>When</dt><dd>${formatDate(bookingA.startsAt)} → ${formatDate(bookingA.endsAt)}</dd>
       </dl>
     </div>
     <a href="${env.APP_URL}/bookings" class="btn">View My Bookings</a>`,
  )
  const text = `Hi ${initiator.displayName},\n\n${recipient.displayName} declined your desk swap request. Your booking for ${assetA.name} (${formatDate(bookingA.startsAt)} → ${formatDate(bookingA.endsAt)}) is unchanged.`
  return { subject, html, text }
}

export function renderBookingSwapExpired(
  bookingA: Pick<Booking, 'startsAt' | 'endsAt'>,
  initiator: Pick<User, 'displayName'>,
  assetA: Pick<Asset, 'name'>,
): { subject: string; html: string; text: string } {
  const subject = `Your swap request expired — ${assetA.name}`
  const html = baseHtml(
    subject,
    `<h1>Swap request expired</h1>
     <p>Hi ${escapeHtml(initiator.displayName)}, nobody responded to your desk swap request in time. Your booking is unchanged.</p>
     <div class="detail">
       <dl>
         <dt>Asset</dt><dd>${escapeHtml(assetA.name)}</dd>
         <dt>When</dt><dd>${formatDate(bookingA.startsAt)} → ${formatDate(bookingA.endsAt)}</dd>
       </dl>
     </div>
     <a href="${env.APP_URL}/bookings" class="btn">View My Bookings</a>`,
  )
  const text = `Hi ${initiator.displayName},\n\nNobody responded to your desk swap request for ${assetA.name} (${formatDate(bookingA.startsAt)} → ${formatDate(bookingA.endsAt)}) in time. Your booking is unchanged.`
  return { subject, html, text }
}

export function renderManagerRequestSubmitted(
  approver: Pick<User, 'displayName'>,
  requester: Pick<User, 'displayName' | 'email'>,
  floor: { name: string; buildingName: string },
): { subject: string; html: string; text: string } {
  const subject = `Floor manager access request — ${floor.name}`
  const html = baseHtml(
    subject,
    `<h1>Floor manager access request</h1>
     <p>Hi ${escapeHtml(approver.displayName)}, ${escapeHtml(requester.displayName)} (${escapeHtml(requester.email)}) has requested floor manager access.</p>
     <div class="detail">
       <dl>
         <dt>Floor</dt><dd>${escapeHtml(floor.name)}, ${escapeHtml(floor.buildingName)}</dd>
       </dl>
     </div>
     <a href="${env.APP_URL}/admin/manager-requests" class="btn">Review Request</a>`,
  )
  const text = `Hi ${approver.displayName},\n\n${requester.displayName} (${requester.email}) has requested floor manager access to ${floor.name}, ${floor.buildingName}. Review it at ${env.APP_URL}/admin/manager-requests`
  return { subject, html, text }
}

export function renderManagerRequestApproved(
  requester: Pick<User, 'displayName'>,
  floor: { name: string; buildingName: string },
): { subject: string; html: string; text: string } {
  const subject = `Floor manager access approved — ${floor.name}`
  const html = baseHtml(
    subject,
    `<h1>Access request approved</h1>
     <p>Hi ${escapeHtml(requester.displayName)}, you're now a floor manager for ${escapeHtml(floor.name)}, ${escapeHtml(floor.buildingName)}.</p>
     <a href="${env.APP_URL}/floors" class="btn">Go to Floor</a>`,
  )
  const text = `Hi ${requester.displayName},\n\nYou're now a floor manager for ${floor.name}, ${floor.buildingName}.`
  return { subject, html, text }
}

export function renderManagerRequestRejected(
  requester: Pick<User, 'displayName'>,
  floor: { name: string; buildingName: string },
  reviewNote: string | null,
): { subject: string; html: string; text: string } {
  const subject = `Floor manager access declined — ${floor.name}`
  const html = baseHtml(
    subject,
    `<h1>Access request declined</h1>
     <p>Hi ${escapeHtml(requester.displayName)}, your request for floor manager access to ${escapeHtml(floor.name)}, ${escapeHtml(floor.buildingName)} was declined.</p>
     ${reviewNote ? `<div class="detail"><dl><dt>Note</dt><dd>${escapeHtml(reviewNote)}</dd></dl></div>` : ''}`,
  )
  const text = `Hi ${requester.displayName},\n\nYour request for floor manager access to ${floor.name}, ${floor.buildingName} was declined.${reviewNote ? `\n\nNote: ${reviewNote}` : ''}`
  return { subject, html, text }
}

export function renderManagerRequestExpired(
  requester: Pick<User, 'displayName'>,
  floor: { name: string; buildingName: string },
): { subject: string; html: string; text: string } {
  const subject = `Floor manager access request expired — ${floor.name}`
  const html = baseHtml(
    subject,
    `<h1>Access request expired</h1>
     <p>Hi ${escapeHtml(requester.displayName)}, nobody reviewed your floor manager access request for ${escapeHtml(floor.name)}, ${escapeHtml(floor.buildingName)} in time, so it's been automatically closed. You're welcome to request again.</p>
     <a href="${env.APP_URL}/floors" class="btn">Go to Floor</a>`,
  )
  const text = `Hi ${requester.displayName},\n\nNobody reviewed your floor manager access request for ${floor.name}, ${floor.buildingName} in time, so it's been automatically closed. You're welcome to request again.`
  return { subject, html, text }
}

// ─── LEASE_EXPIRING / LEASE_EXPIRED (see #222) ────────────────────────────────

export function renderLeaseExpiring(
  recipient: Pick<User, 'displayName'>,
  lease: { name: string; buildingName: string; endDate: Date },
  daysLeft: number,
): { subject: string; html: string; text: string } {
  const subject = `Lease expiring in ${daysLeft} day${daysLeft === 1 ? '' : 's'} — ${lease.buildingName}`
  const html = baseHtml(
    subject,
    `<h1>Lease expiring soon</h1>
     <p>Hi ${escapeHtml(recipient.displayName)}, the <strong>${escapeHtml(lease.name)}</strong> lease for <strong>${escapeHtml(lease.buildingName)}</strong> expires in ${daysLeft} day${daysLeft === 1 ? '' : 's'}.</p>
     <div class="detail">
       <dl>
         <dt>Building</dt><dd>${escapeHtml(lease.buildingName)}</dd>
         <dt>Expires</dt><dd>${formatDate(lease.endDate)}</dd>
       </dl>
     </div>
     <a href="${env.APP_URL}/admin/leases" class="btn">View Leases</a>`,
  )
  const text = `Hi ${recipient.displayName},\n\nThe ${lease.name} lease for ${lease.buildingName} expires in ${daysLeft} day${daysLeft === 1 ? '' : 's'} (${formatDate(lease.endDate)}).\n\nView: ${env.APP_URL}/admin/leases`
  return { subject, html, text }
}

export function renderLeaseExpired(
  recipient: Pick<User, 'displayName'>,
  lease: { name: string; buildingName: string; endDate: Date },
): { subject: string; html: string; text: string } {
  const subject = `Lease expired — ${lease.buildingName}`
  const html = baseHtml(
    subject,
    `<h1>Lease expired</h1>
     <p>Hi ${escapeHtml(recipient.displayName)}, the <strong>${escapeHtml(lease.name)}</strong> lease for <strong>${escapeHtml(lease.buildingName)}</strong> has expired.</p>
     <div class="detail">
       <dl>
         <dt>Building</dt><dd>${escapeHtml(lease.buildingName)}</dd>
         <dt>Expired</dt><dd>${formatDate(lease.endDate)}</dd>
       </dl>
     </div>
     <a href="${env.APP_URL}/admin/leases" class="btn">View Leases</a>`,
  )
  const text = `Hi ${recipient.displayName},\n\nThe ${lease.name} lease for ${lease.buildingName} expired on ${formatDate(lease.endDate)}.\n\nView: ${env.APP_URL}/admin/leases`
  return { subject, html, text }
}

// ─── BOOKING_PENDING_APPROVAL / BOOKING_APPROVED / BOOKING_REJECTED (see #74) ─

export function renderBookingPendingApproval(
  approver: Pick<User, 'displayName'>,
  requester: Pick<User, 'displayName' | 'email'>,
  booking: Pick<Booking, 'startsAt' | 'endsAt'>,
  asset: Pick<Asset, 'name'>,
  timeZone = 'UTC',
): { subject: string; html: string; text: string } {
  const subject = `Booking approval requested — ${asset.name}`
  const html = baseHtml(
    subject,
    `<h1>Booking approval requested</h1>
     <p>Hi ${escapeHtml(approver.displayName)}, ${escapeHtml(requester.displayName)} (${escapeHtml(requester.email)}) has requested a booking that needs your approval.</p>
     <div class="detail">
       <dl>
         <dt>Asset</dt><dd>${escapeHtml(asset.name)}</dd>
         <dt>When</dt><dd>${formatDate(booking.startsAt, timeZone)} → ${formatDate(booking.endsAt, timeZone)}</dd>
       </dl>
     </div>
     <a href="${env.APP_URL}/admin/approvals" class="btn">Review Request</a>`,
  )
  const text = `Hi ${approver.displayName},\n\n${requester.displayName} (${requester.email}) has requested a booking for ${asset.name} (${formatDate(booking.startsAt, timeZone)} → ${formatDate(booking.endsAt, timeZone)}) that needs your approval.\n\nReview it at ${env.APP_URL}/admin/approvals`
  return { subject, html, text }
}

export function renderBookingApproved(
  requester: Pick<User, 'displayName'>,
  booking: Pick<Booking, 'startsAt' | 'endsAt'>,
  asset: Pick<Asset, 'name'>,
  timeZone = 'UTC',
): { subject: string; html: string; text: string } {
  const subject = `Booking approved — ${asset.name}`
  const html = baseHtml(
    subject,
    `<h1>Booking approved</h1>
     <p>Hi ${escapeHtml(requester.displayName)}, your booking for ${escapeHtml(asset.name)} has been approved.</p>
     <div class="detail">
       <dl>
         <dt>Asset</dt><dd>${escapeHtml(asset.name)}</dd>
         <dt>When</dt><dd>${formatDate(booking.startsAt, timeZone)} → ${formatDate(booking.endsAt, timeZone)}</dd>
       </dl>
     </div>
     <a href="${env.APP_URL}/bookings" class="btn">View My Bookings</a>`,
  )
  const text = `Hi ${requester.displayName},\n\nYour booking for ${asset.name} (${formatDate(booking.startsAt, timeZone)} → ${formatDate(booking.endsAt, timeZone)}) has been approved.`
  return { subject, html, text }
}

export function renderBookingRejected(
  requester: Pick<User, 'displayName'>,
  booking: Pick<Booking, 'startsAt' | 'endsAt'>,
  asset: Pick<Asset, 'name'>,
  rejectionNote: string | null,
  timeZone = 'UTC',
): { subject: string; html: string; text: string } {
  const subject = `Booking request declined — ${asset.name}`
  const html = baseHtml(
    subject,
    `<h1>Booking request declined</h1>
     <p>Hi ${escapeHtml(requester.displayName)}, your booking request for ${escapeHtml(asset.name)} (${formatDate(booking.startsAt, timeZone)} → ${formatDate(booking.endsAt, timeZone)}) was declined.</p>
     ${rejectionNote ? `<div class="detail"><dl><dt>Note</dt><dd>${escapeHtml(rejectionNote)}</dd></dl></div>` : ''}
     <a href="${env.APP_URL}/bookings" class="btn">View My Bookings</a>`,
  )
  const text = `Hi ${requester.displayName},\n\nYour booking request for ${asset.name} (${formatDate(booking.startsAt, timeZone)} → ${formatDate(booking.endsAt, timeZone)}) was declined.${rejectionNote ? `\n\nNote: ${rejectionNote}` : ''}`
  return { subject, html, text }
}

// ─── Visitor/guest booking invite (see #79) ───────────────────────────────────
// Sent directly to guestEmail rather than through the Notification/
// enqueueNotification pipeline — a guest has no User row, so there's no
// userId to key a Notification on and no in-app bell to show it in.

export function renderGuestBookingInvite(
  guestName: string,
  host: Pick<User, 'displayName'>,
  booking: Pick<Booking, 'startsAt' | 'endsAt'>,
  asset: Pick<Asset, 'name'> & { zoneName?: string; floorName?: string; buildingName?: string },
  checkInUrl: string,
  timeZone = 'UTC',
): { subject: string; html: string; text: string } {
  const subject = `You're booked in — ${asset.name}`
  const safeGuest = escapeHtml(guestName)
  const safeHost = escapeHtml(host.displayName)
  const safeAsset = escapeHtml(asset.name)
  const location = [asset.zoneName, asset.floorName, asset.buildingName].filter((v): v is string => !!v).map(escapeHtml).join(', ')
  const html = baseHtml(
    subject,
    `<h1>You're booked in</h1>
     <p>Hi ${safeGuest}, ${safeHost} has booked ${safeAsset} for your visit.</p>
     <div class="detail">
       <dl>
         <dt>Location</dt><dd>${safeAsset}${location ? ` — ${location}` : ''}</dd>
         <dt>From</dt><dd>${formatDate(booking.startsAt, timeZone)}</dd>
         <dt>To</dt><dd>${formatDate(booking.endsAt, timeZone)}</dd>
       </dl>
     </div>
     <p>When you arrive, tap the button below to check in.</p>
     <a href="${checkInUrl}" class="btn">Check In</a>`,
  )
  const text = `Hi ${guestName},\n\n${host.displayName} has booked ${asset.name}${location ? ` (${location})` : ''} for your visit.\nFrom: ${formatDate(booking.startsAt, timeZone)}\nTo: ${formatDate(booking.endsAt, timeZone)}\n\nCheck in when you arrive: ${checkInUrl}`
  return { subject, html, text }
}

/**
 * A guest has no User row and no in-app bell, so an invite is the only
 * channel they ever get — without this, a cancelled visit only surfaced to
 * them as a dead check-in link on the day, with no explanation.
 */
export function renderGuestBookingCancelled(
  guestName: string,
  host: Pick<User, 'displayName'>,
  booking: Pick<Booking, 'startsAt' | 'endsAt'>,
  asset: Pick<Asset, 'name'>,
  timeZone = 'UTC',
): { subject: string; html: string; text: string } {
  const subject = `Your visit has been cancelled — ${asset.name}`
  const safeGuest = escapeHtml(guestName)
  const safeHost = escapeHtml(host.displayName)
  const safeAsset = escapeHtml(asset.name)
  const html = baseHtml(
    subject,
    `<h1>Visit cancelled</h1>
     <p>Hi ${safeGuest}, your visit booked by ${safeHost} has been cancelled.</p>
     <div class="detail">
       <dl>
         <dt>Was scheduled</dt><dd>${safeAsset} — ${formatDate(booking.startsAt, timeZone)} → ${formatDate(booking.endsAt, timeZone)}</dd>
       </dl>
     </div>
     <p>Your check-in link for this visit is no longer valid.</p>`,
  )
  const text = `Hi ${guestName},\n\nYour visit booked by ${host.displayName} (${asset.name}, ${formatDate(booking.startsAt, timeZone)} → ${formatDate(booking.endsAt, timeZone)}) has been cancelled.\n\nYour check-in link for this visit is no longer valid.`
  return { subject, html, text }
}

// ─── BALLOT_WON / BALLOT_LOST (see #159) ──────────────────────────────────────

export function renderBallotWon(
  user: Pick<User, 'displayName'>,
  ballotName: string,
  asset: Pick<Asset, 'name'>,
  slot: Pick<Booking, 'startsAt' | 'endsAt'>,
  timeZone = 'UTC',
): { subject: string; html: string; text: string } {
  const subject = `You won the ${ballotName} ballot — ${asset.name}`
  const html = baseHtml(
    subject,
    `<h1>You won!</h1>
     <p>Hi ${escapeHtml(user.displayName)}, you've been randomly assigned <strong>${escapeHtml(asset.name)}</strong> from the <strong>${escapeHtml(ballotName)}</strong> ballot.</p>
     <div class="detail">
       <dl>
         <dt>Asset</dt><dd>${escapeHtml(asset.name)}</dd>
         <dt>From</dt><dd>${formatDate(slot.startsAt, timeZone)}</dd>
         <dt>To</dt><dd>${formatDate(slot.endsAt, timeZone)}</dd>
       </dl>
     </div>
     <p>This is now a confirmed booking on your account — if you don't want it, you can decline it from the Ballots page, which gives it to someone else who entered.</p>
     <a href="${env.APP_URL}/bookings" class="btn">View My Bookings</a>`,
  )
  const text = `Hi ${user.displayName},\n\nYou've been randomly assigned ${asset.name} from the ${ballotName} ballot.\nFrom: ${formatDate(slot.startsAt, timeZone)}\nTo: ${formatDate(slot.endsAt, timeZone)}\n\nThis is now a confirmed booking — if you don't want it, decline it from the Ballots page.\n\nView: ${env.APP_URL}/bookings`
  return { subject, html, text }
}

export function renderBallotLost(
  user: Pick<User, 'displayName'>,
  ballotName: string,
): { subject: string; html: string; text: string } {
  const subject = `${ballotName} ballot results`
  const html = baseHtml(
    subject,
    `<h1>Ballot results</h1>
     <p>Hi ${escapeHtml(user.displayName)}, you weren't assigned an asset in this round of the <strong>${escapeHtml(ballotName)}</strong> ballot — there were more entrants than available spots.</p>
     <a href="${env.APP_URL}/ballots" class="btn">View Ballots</a>`,
  )
  const text = `Hi ${user.displayName},\n\nYou weren't assigned an asset in this round of the ${ballotName} ballot — there were more entrants than available spots.\n\nView: ${env.APP_URL}/ballots`
  return { subject, html, text }
}
