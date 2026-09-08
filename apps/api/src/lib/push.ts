import webpush from 'web-push'
import { env } from '../env.js'
import { prisma } from './prisma.js'
import { sendPinnedPush } from './push-transport.js'
import { pushDeliveryTotal } from './metrics.js'

let vapidConfigured = false
let warnedMissingVapid = false

function ensureVapidConfigured(): boolean {
  if (vapidConfigured) return true
  if (!env.VAPID_PUBLIC_KEY || !env.VAPID_PRIVATE_KEY) {
    if (!warnedMissingVapid) {
      warnedMissingVapid = true
      process.stderr.write(
        JSON.stringify({ level: 'warn', event: 'push.disabled', msg: '[push] VAPID_PUBLIC_KEY/VAPID_PRIVATE_KEY not set — push notifications are disabled' }) + '\n',
      )
    }
    return false
  }
  webpush.setVapidDetails(env.VAPID_SUBJECT, env.VAPID_PUBLIC_KEY, env.VAPID_PRIVATE_KEY)
  vapidConfigured = true
  return true
}

/** The VAPID public key the frontend needs to call pushManager.subscribe(). Null when push isn't configured on this deployment. */
export function getVapidPublicKey(): string | null {
  return ensureVapidConfigured() ? env.VAPID_PUBLIC_KEY! : null
}

/** Origin of a push endpoint, for diagnostics. The full endpoint URL is a
 * bearer credential for that subscription, so only the origin is ever logged. */
function safeOrigin(endpoint: string): string {
  try {
    return new URL(endpoint).origin
  } catch {
    return 'unknown'
  }
}

export interface PushPayload {
  title: string
  body: string
  /** Deep link opened on notification click — falls back to APP_URL if omitted. */
  url?: string
}

/**
 * Push to every subscription this user has (they may have several — one per
 * browser/device). Best-effort per-subscription: one dead endpoint doesn't
 * stop delivery to the user's other devices. A subscription the push service
 * reports as gone (404/410 — the browser unsubscribed, cleared site data, or
 * the endpoint otherwise expired) is pruned so it isn't retried forever.
 */
export async function sendPushNotification(userId: string, payload: PushPayload): Promise<void> {
  if (!ensureVapidConfigured()) return

  const subscriptions = await prisma.pushSubscription.findMany({ where: { userId } })
  if (subscriptions.length === 0) return

  const body = JSON.stringify(payload)

  // Bound outbound sockets even when a user has many registered devices.
  for (let offset = 0; offset < subscriptions.length; offset += 5) {
    await Promise.all(subscriptions.slice(offset, offset + 5).map(async (sub) => {
      try {
        await sendPinnedPush(
          { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } }, body,
        )
        pushDeliveryTotal.inc({ outcome: 'sent' })
      } catch (err) {
        const statusCode = err instanceof webpush.WebPushError ? err.statusCode : undefined
        if (statusCode === 404 || statusCode === 410) {
          // Routine churn, not a fault — counted separately so it doesn't
          // sit under the failure ratio operators alert on. See metrics.ts.
          pushDeliveryTotal.inc({ outcome: 'expired' })
          await prisma.pushSubscription.deleteMany({ where: { id: sub.id } }).catch(() => {})
        } else {
          pushDeliveryTotal.inc({ outcome: 'failed' })
          // Stable `event` key so this is greppable/queryable as a class
          // rather than by matching on prose, and the endpoint's origin (not
          // the full URL, which is a bearer credential for that subscription)
          // so an outage isolated to one push service is distinguishable from
          // a broken VAPID config affecting all of them.
          process.stderr.write(
            JSON.stringify({
              level: 'error',
              event: 'push.delivery_failed',
              msg: '[push] Failed to send',
              userId,
              statusCode,
              endpointOrigin: safeOrigin(sub.endpoint),
              err: String(err),
            }) + '\n',
          )
        }
      }
    }))
  }
}
