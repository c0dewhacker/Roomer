import webpush from 'web-push'
import { env } from '../env.js'
import { prisma } from './prisma.js'

let vapidConfigured = false
let warnedMissingVapid = false

function ensureVapidConfigured(): boolean {
  if (vapidConfigured) return true
  if (!env.VAPID_PUBLIC_KEY || !env.VAPID_PRIVATE_KEY) {
    if (!warnedMissingVapid) {
      warnedMissingVapid = true
      process.stderr.write(
        JSON.stringify({ level: 'warn', msg: '[push] VAPID_PUBLIC_KEY/VAPID_PRIVATE_KEY not set — push notifications are disabled' }) + '\n',
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

  await Promise.all(
    subscriptions.map(async (sub) => {
      try {
        await webpush.sendNotification(
          { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
          body,
        )
      } catch (err) {
        const statusCode = err instanceof webpush.WebPushError ? err.statusCode : undefined
        if (statusCode === 404 || statusCode === 410) {
          await prisma.pushSubscription.deleteMany({ where: { id: sub.id } }).catch(() => {})
        } else {
          process.stderr.write(
            JSON.stringify({ level: 'error', msg: '[push] Failed to send', userId, statusCode, err: String(err) }) + '\n',
          )
        }
      }
    }),
  )
}
