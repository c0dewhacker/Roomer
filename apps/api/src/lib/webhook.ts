import crypto from 'crypto'
import { randomUUID } from 'crypto'
import { prisma } from './prisma.js'
import { getBoss } from './queue.js'
import type { Job } from 'pg-boss'

export const WEBHOOK_EVENTS = [
  'booking.created',
  'booking.modified',
  'booking.cancelled',
  'booking.completed',
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
  secret: string
  event: WebhookEvent
  payload: string // pre-serialised JSON
}

function sign(secret: string, body: string): string {
  return `sha256=${crypto.createHmac('sha256', secret).update(body).digest('hex')}`
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
    select: { id: true, url: true, secret: true },
  })
  if (endpoints.length === 0) return

  const timestamp = new Date().toISOString()
  const enriched = await enrichPayload(event, data)
  const payload = JSON.stringify({ event, timestamp, data: enriched })

  const boss = getBoss()
  await boss.insert(
    'webhook-delivery',
    endpoints.map((ep) => {
      const deliveryId = randomUUID()
      return {
        data: {
          endpointId: ep.id,
          deliveryId,
          url: ep.url,
          secret: ep.secret,
          event,
          payload,
        } satisfies WebhookDeliveryJobData,
        retryLimit: 5,
        retryDelay: 60,
        retryBackoff: true,
        expireInSeconds: 86400,
      }
    }),
  )
}

/** pg-boss worker handler — called for each batch of webhook-delivery jobs. */
export async function deliverWebhookJob(jobs: Job<WebhookDeliveryJobData>[]): Promise<void> {
  for (const job of jobs) {
    await deliverOne(job.data)
  }
}

async function deliverOne({ endpointId, deliveryId, url, secret, event, payload }: WebhookDeliveryJobData): Promise<void> {
  const signature = sign(secret, payload)

  let statusCode: number | null = null
  let success = false
  let error: string | null = null

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Roomer-Event': event,
        'X-Roomer-Delivery': deliveryId,
        'X-Roomer-Signature': signature,
      },
      body: payload,
      signal: AbortSignal.timeout(10_000),
    })
    statusCode = res.status
    success = res.ok
    if (!res.ok) error = `HTTP ${res.status}`
  } catch (err) {
    error = err instanceof Error ? err.message : 'Unknown error'
  }

  await prisma.webhookDelivery.create({
    data: {
      id: deliveryId,
      endpointId,
      event,
      payload: JSON.parse(payload),
      statusCode,
      success,
      error,
      attempt: 1,
    },
  })

  if (!success) throw new Error(error ?? 'Delivery failed')
}
