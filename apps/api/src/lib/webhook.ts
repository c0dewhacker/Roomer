import crypto from 'crypto'
import { randomUUID } from 'crypto'
import dnsPromises from 'dns/promises'
import net from 'net'
import { prisma } from './prisma.js'
import { getBoss } from './queue.js'
import { env } from '../env.js'
import { decryptStringMaybe } from './encryption.js'
import type { Job } from 'pg-boss'

export const WEBHOOK_EVENTS = [
  'booking.created',
  'booking.modified',
  'booking.cancelled',
  'booking.completed',
  'booking.checked_in',
  'booking.no_show',
  'queue.joined',
  'queue.promoted',
  'queue.claimed',
  'queue.expired',
  'queue.cancelled',
  'asset.created',
  'asset.updated',
  'asset.status_changed',
  'asset_assignment.created',
  'asset_assignment.returned',
  'user.created',
  'user.updated',
  'user.suspended',
  'user.imported',
] as const

export type WebhookEvent = (typeof WEBHOOK_EVENTS)[number]

export interface WebhookDeliveryJobData {
  endpointId: string
  deliveryId: string
  url: string
  // NB: the signing secret is deliberately NOT carried in the job payload (which
  // is persisted in pg-boss tables). It is looked up and decrypted at delivery
  // time from the WebhookEndpoint row.
  event: WebhookEvent | 'ping'
  payload: string // pre-serialised JSON
}

function sign(secret: string, body: string): string {
  return `sha256=${crypto.createHmac('sha256', secret).update(body).digest('hex')}`
}

/** True for loopback / link-local / unspecified addresses — always blocked. */
function isAlwaysBlockedIp(ip: string): boolean {
  const v = ip.startsWith('::ffff:') ? ip.slice(7) : ip // unwrap IPv4-mapped IPv6
  if (net.isIPv4(v)) {
    const o = v.split('.').map(Number)
    if (o[0] === 127) return true                    // 127.0.0.0/8 loopback
    if (o[0] === 169 && o[1] === 254) return true    // 169.254.0.0/16 link-local (cloud metadata)
    if (o[0] === 0) return true                      // 0.0.0.0/8
    return false
  }
  const lower = ip.toLowerCase()
  if (lower === '::1' || lower === '::') return true  // loopback / unspecified
  if (lower.startsWith('fe80')) return true           // link-local
  return false
}

/** True for RFC1918 / ULA / CGNAT ranges — blocked unless WEBHOOK_ALLOW_PRIVATE. */
function isPrivateIp(ip: string): boolean {
  const v = ip.startsWith('::ffff:') ? ip.slice(7) : ip
  if (net.isIPv4(v)) {
    const o = v.split('.').map(Number)
    if (o[0] === 10) return true                                   // 10.0.0.0/8
    if (o[0] === 172 && o[1] >= 16 && o[1] <= 31) return true      // 172.16.0.0/12
    if (o[0] === 192 && o[1] === 168) return true                  // 192.168.0.0/16
    if (o[0] === 100 && o[1] >= 64 && o[1] <= 127) return true     // 100.64.0.0/10 CGNAT
    return false
  }
  const lower = ip.toLowerCase()
  return lower.startsWith('fc') || lower.startsWith('fd')          // fc00::/7 ULA
}

function ipIsBlocked(ip: string): boolean {
  if (isAlwaysBlockedIp(ip)) return true
  if (!env.WEBHOOK_ALLOW_PRIVATE && isPrivateIp(ip)) return true
  return false
}

/**
 * Reject webhook targets that resolve to internal/reserved addresses (SSRF guard).
 * Resolution happens at delivery time (not just on save) to also catch DNS
 * rebinding. Set ROOMER_WEBHOOK_ALLOW_PRIVATE=true to permit private ranges for
 * internal integrations (loopback and link-local remain blocked regardless).
 */
export async function assertPublicWebhookUrl(rawUrl: string): Promise<void> {
  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    throw new Error('Invalid webhook URL')
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('Webhook URL must use http or https')
  }
  const host = url.hostname
  if (host === 'localhost') throw new Error('Webhook URL host is not allowed')

  if (net.isIP(host)) {
    if (ipIsBlocked(host)) throw new Error('Webhook URL resolves to a disallowed address')
    return
  }

  const records = await dnsPromises.lookup(host, { all: true })
  if (records.length === 0) throw new Error('Webhook URL host could not be resolved')
  for (const { address } of records) {
    if (ipIsBlocked(address)) throw new Error('Webhook URL resolves to a disallowed address')
  }
}

const assetInclude = {
  category: { select: { name: true } },
  primaryZone: { select: { name: true } },
  floor: { select: { name: true, building: { select: { name: true } } } },
} as const

async function enrichPayload(event: WebhookEvent, data: unknown): Promise<unknown> {
  const d = data as Record<string, unknown>

  if (event.startsWith('booking.')) {
    const booking = await prisma.booking.findUnique({
      where: { id: d.id as string },
      select: {
        user: { select: { id: true, email: true, displayName: true } },
        asset: { select: { id: true, name: true, ...assetInclude } },
      },
    }).catch(() => null)
    return {
      ...d,
      ...(booking?.user && { user: booking.user }),
      ...(booking?.asset && { asset: booking.asset }),
    }
  }

  if (event.startsWith('queue.')) {
    const entry = await prisma.queueEntry.findUnique({
      where: { id: d.id as string },
      select: {
        user: { select: { id: true, email: true, displayName: true } },
        asset: { select: { id: true, name: true, ...assetInclude } },
      },
    }).catch(() => null)
    return {
      ...d,
      ...(entry?.user && { user: entry.user }),
      ...(entry?.asset && { asset: entry.asset }),
    }
  }

  if (event === 'asset.created' || event === 'asset.updated' || event === 'asset.status_changed') {
    const asset = await prisma.asset.findUnique({
      where: { id: d.id as string },
      select: { name: true, ...assetInclude },
    }).catch(() => null)
    return { ...d, ...(asset && { asset }) }
  }

  if (event === 'asset_assignment.created' || event === 'asset_assignment.returned') {
    const [asset, user] = await Promise.all([
      prisma.asset.findUnique({ where: { id: d.assetId as string }, select: { name: true, ...assetInclude } }).catch(() => null),
      prisma.user.findUnique({ where: { id: d.userId as string }, select: { id: true, email: true, displayName: true } }).catch(() => null),
    ])
    return {
      ...d,
      ...(asset && { asset: { id: d.assetId, ...asset } }),
      ...(user && { user }),
    }
  }

  if (event === 'user.created' || event === 'user.updated' || event === 'user.suspended') {
    const user = await prisma.user.findUnique({
      where: { id: d.id as string },
      select: { id: true, email: true, displayName: true, globalRole: true, accountStatus: true, departmentId: true },
    }).catch(() => null)
    return { ...d, ...(user && { user }) }
  }

  return data
}

/** Enqueue a webhook delivery job for every enabled endpoint subscribed to the event. */
export async function dispatchWebhook(event: WebhookEvent, data: unknown): Promise<void> {
  const endpoints = await prisma.webhookEndpoint.findMany({
    where: { enabled: true, events: { has: event } },
    select: { id: true, url: true },
  })
  if (endpoints.length === 0) return

  const timestamp = new Date().toISOString()
  const enriched = await enrichPayload(event, data)
  const payload = JSON.stringify({ event, timestamp, data: enriched })

  const boss = getBoss()
  await boss.insert(
    'webhook-delivery',
    endpoints.map((ep) => ({
      data: {
        endpointId: ep.id,
        deliveryId: randomUUID(),
        url: ep.url,
        event,
        payload,
      } satisfies WebhookDeliveryJobData,
      retryLimit: 5,
      retryDelay: 60,
      retryBackoff: true,
      expireInSeconds: 86400,
    })),
  )
}

/**
 * Send a one-off test delivery to a single endpoint. Unlike a normal dispatch
 * this targets exactly the given endpoint (regardless of its enabled state or
 * event subscriptions) and never fans out to other endpoints.
 */
export async function dispatchPing(endpointId: string): Promise<void> {
  const ep = await prisma.webhookEndpoint.findUnique({
    where: { id: endpointId },
    select: { id: true, url: true },
  })
  if (!ep) return

  const payload = JSON.stringify({
    event: 'ping',
    timestamp: new Date().toISOString(),
    data: { ok: true, message: 'Test ping from Roomer' },
  })

  const boss = getBoss()
  await boss.insert('webhook-delivery', [{
    data: {
      endpointId: ep.id,
      deliveryId: randomUUID(),
      url: ep.url,
      event: 'ping',
      payload,
    } satisfies WebhookDeliveryJobData,
    retryLimit: 0,
    expireInSeconds: 3600,
  }])
}

/** pg-boss worker handler — called for each batch of webhook-delivery jobs. */
export async function deliverWebhookJob(jobs: Job<WebhookDeliveryJobData>[]): Promise<void> {
  for (const job of jobs) {
    // pg-boss exposes the zero-based retry counter as `retryCount`; attempt is 1-based.
    const attempt = ((job as { retryCount?: number }).retryCount ?? 0) + 1
    await deliverOne(job.data, attempt)
  }
}

async function deliverOne({ endpointId, deliveryId, url, event, payload }: WebhookDeliveryJobData, attempt: number): Promise<void> {
  let statusCode: number | null = null
  let success = false
  let error: string | null = null

  try {
    // Look up + decrypt the signing secret at delivery time (it is not stored in
    // the job payload). A deleted endpoint means there is nothing to deliver.
    const ep = await prisma.webhookEndpoint.findUnique({ where: { id: endpointId }, select: { secret: true } })
    if (!ep) return
    const secret = decryptStringMaybe(ep.secret)

    // SSRF guard — resolve and reject internal/reserved targets (also catches rebinding).
    await assertPublicWebhookUrl(url)

    const signature = sign(secret, payload)
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Roomer-Event': event,
        'X-Roomer-Delivery': deliveryId,
        'X-Roomer-Signature': signature,
      },
      body: payload,
      redirect: 'error', // do not follow redirects — prevents redirect-based SSRF
      signal: AbortSignal.timeout(10_000),
    })
    statusCode = res.status
    success = res.ok
    if (!res.ok) error = `HTTP ${res.status}`
  } catch (err) {
    error = err instanceof Error ? err.message : 'Unknown error'
  }

  // Upsert keyed on the stable deliveryId so retries update the same log row
  // (the id is reused across attempts) rather than colliding on the primary key.
  const record = { event, payload: JSON.parse(payload), statusCode, success, error, attempt }
  await prisma.webhookDelivery.upsert({
    where: { id: deliveryId },
    create: { id: deliveryId, endpointId, ...record },
    update: record,
  })

  if (!success) throw new Error(error ?? 'Delivery failed')
}
