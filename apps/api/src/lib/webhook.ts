import crypto from 'crypto'
import { randomUUID } from 'crypto'
import { Agent, fetch as undiciFetch } from 'undici'
import { prisma } from './prisma.js'
import { getBoss } from './queue.js'
import { env } from '../env.js'
import { decryptStringMaybe } from './encryption.js'
import { resolveValidatedHost as resolveValidatedHostShared } from './url-safety.js'
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
  'user.created',
  'user.updated',
  'user.suspended',
  'user.imported',
  'booking.transfer_requested',
  'booking.transfer_accepted',
  'booking.transfer_declined',
  'booking.transfer_expired',
  'booking.swap_requested',
  'booking.swap_accepted',
  'booking.swap_declined',
  'booking.swap_expired',
  'manager_request.submitted',
  'manager_request.approved',
  'manager_request.rejected',
  'manager_request.expired',
  'lease.expiring',
  'lease.expired',
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

/**
 * Resolve `rawUrl`'s host and reject internal/reserved addresses (SSRF guard) —
 * webhook-specific wrapper around the shared lib/url-safety.ts resolver,
 * pre-configured for http(s) URLs with the ROOMER_WEBHOOK_ALLOW_PRIVATE
 * escape hatch for internal integrations (loopback/link-local always
 * blocked regardless). Returns the validated address so callers can pin
 * the subsequent connection to it — see `deliverOne`.
 */
async function resolveValidatedHost(rawUrl: string) {
  return resolveValidatedHostShared(rawUrl, ['http:', 'https:'], env.WEBHOOK_ALLOW_PRIVATE)
}

/**
 * Reject webhook targets that resolve to internal/reserved addresses (SSRF guard).
 * Resolution happens at delivery time (not just on save) to also catch DNS
 * rebinding. Set ROOMER_WEBHOOK_ALLOW_PRIVATE=true to permit private ranges for
 * internal integrations (loopback and link-local remain blocked regardless).
 */
export async function assertPublicWebhookUrl(rawUrl: string): Promise<void> {
  await resolveValidatedHost(rawUrl)
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
    const ep = await prisma.webhookEndpoint.findUnique({ where: { id: endpointId }, select: { secret: true, enabled: true } })
    if (!ep) return
    // The endpoint may have been disabled after this delivery was queued, or
    // between retries of a failing one — without this, an admin disabling a
    // misbehaving or leaked endpoint mid-retry-storm doesn't stop it; pg-boss
    // keeps retrying (up to 5 attempts over 24h) regardless. Record the skip
    // in the delivery log for visibility and stop, rather than throwing (which
    // would just trigger another retry).
    //
    // A ping is exempt: dispatchPing's whole point is "test this endpoint
    // before flipping it live" — an admin configuring a new integration
    // leaves it disabled while wiring up the receiving side, then pings it
    // to check the URL/secret actually work before enabling. Skipping the
    // ping the same way a real event gets skipped turned every such test
    // into a guaranteed, uninformative "Endpoint disabled" failure.
    if (!ep.enabled && event !== 'ping') {
      const record = { event, payload: JSON.parse(payload), statusCode: null, success: false, error: 'Endpoint disabled', attempt }
      await prisma.webhookDelivery.upsert({
        where: { id: deliveryId },
        create: { id: deliveryId, endpointId, ...record },
        update: record,
      })
      return
    }
    const secret = decryptStringMaybe(ep.secret)

    // SSRF guard — resolve and reject internal/reserved targets (also catches rebinding).
    const validated = await resolveValidatedHost(url)

    // Pin the actual connection to the address we just validated. Without this,
    // fetch() would re-resolve the hostname itself, leaving a window for a
    // malicious DNS server to answer the check above with a public IP and the
    // real connection with a private one (fast DNS rebinding). The Host header
    // and TLS SNI/cert validation still use the original hostname from `url` —
    // only the low-level socket target is pinned.
    const pinnedAgent = new Agent({
      connect: {
        lookup: (_hostname, options, callback) => {
          if (options.all) callback(null, [{ address: validated.address, family: validated.family }])
          else callback(null, validated.address, validated.family)
        },
      },
    })

    const signature = sign(secret, payload)
    try {
      // Must use undici's own fetch, not the global one — global fetch() is
      // bound to whatever undici ships *inside* the running Node version,
      // which is not necessarily the same major version as the `undici`
      // npm dependency `pinnedAgent` above is constructed from (Node 24
      // bundles undici 7.x; this repo pins undici ^8). Passing an Agent
      // from one major version as the `dispatcher` for the other's fetch
      // throws "invalid onRequestStart method" — every real delivery to a
      // reachable external endpoint failed with a bare "fetch failed" until
      // this was pinned to the matching fetch implementation.
      const res = await undiciFetch(url, {
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
        dispatcher: pinnedAgent,
      } as RequestInit & { dispatcher: Agent })
      statusCode = res.status
      success = res.ok
      if (!res.ok) error = `HTTP ${res.status}`
    } finally {
      await pinnedAgent.close()
    }
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

  // Health tracking so a permanently-broken endpoint is visible in the admin
  // UI without having to open its delivery history — a single atomic UPDATE
  // (increment/reset), safe under the worker's concurrency. Excludes 'ping':
  // that's a deliberate one-off test, not a real subscriber delivery, and
  // shouldn't move the needle on whether the endpoint looks healthy.
  if (event !== 'ping') {
    await prisma.webhookEndpoint.update({
      where: { id: endpointId },
      data: success
        ? { consecutiveFailures: 0, lastSuccessAt: new Date() }
        : { consecutiveFailures: { increment: 1 } },
    }).catch(() => {})
  }

  if (!success) throw new Error(error ?? 'Delivery failed')
}
