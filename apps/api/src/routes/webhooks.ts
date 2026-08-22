import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { randomBytes } from 'crypto'
import { prisma } from '../lib/prisma.js'
import { requireAuth } from '../middleware/requireAuth.js'
import { requireGlobalRole } from '../middleware/requireRole.js'
import { GlobalRole } from '@roomer/shared'
import { WEBHOOK_EVENTS, assertPublicWebhookUrl, dispatchPing } from '../lib/webhook.js'
import { encrypt } from '../lib/encryption.js'
import { recordAuditLog } from '../lib/audit.js'

const createEndpointSchema = z.object({
  url: z.string().url(),
  events: z.array(z.enum(WEBHOOK_EVENTS)).min(1),
  secret: z.string().min(16).optional(),
  enabled: z.boolean().optional(),
})

const updateEndpointSchema = z.object({
  url: z.string().url().optional(),
  events: z.array(z.enum(WEBHOOK_EVENTS)).min(1).optional(),
  secret: z.string().min(16).optional(),
  enabled: z.boolean().optional(),
})

export async function webhookRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.addHook('onRoute', (route) => { route.schema = { tags: ['Webhooks'], ...route.schema } })

  const adminGuard = [requireAuth, requireGlobalRole(GlobalRole.SUPER_ADMIN)]

  // GET /webhooks/events — list all supported event types
  fastify.get('/events', { preHandler: [requireAuth] }, async (_req, reply) => {
    return reply.send({ data: WEBHOOK_EVENTS })
  })

  // GET /webhooks — list all endpoints
  fastify.get('/', { preHandler: adminGuard }, async (_req, reply) => {
    const endpoints = await prisma.webhookEndpoint.findMany({
      orderBy: { createdAt: 'asc' },
      select: { id: true, url: true, events: true, enabled: true, consecutiveFailures: true, lastSuccessAt: true, createdAt: true, updatedAt: true },
    })
    return reply.send({ data: endpoints })
  })

  // POST /webhooks — create endpoint
  fastify.post('/', { preHandler: adminGuard }, async (request, reply) => {
    const result = createEndpointSchema.safeParse(request.body)
    if (!result.success) {
      return reply.status(400).send({ error: { message: 'Validation failed', code: 'VALIDATION_ERROR', details: result.error.flatten() } })
    }
    try {
      await assertPublicWebhookUrl(result.data.url)
    } catch (err) {
      return reply.status(400).send({ error: { message: err instanceof Error ? err.message : 'Invalid webhook URL', code: 'INVALID_WEBHOOK_URL' } })
    }

    const secret = result.data.secret ?? randomBytes(32).toString('hex')
    const endpoint = await prisma.webhookEndpoint.create({
      data: {
        url: result.data.url,
        secret: encrypt(secret),               // encrypted at rest
        events: result.data.events,
        enabled: result.data.enabled ?? true,
      },
      select: { id: true, url: true, events: true, enabled: true, consecutiveFailures: true, lastSuccessAt: true, createdAt: true, updatedAt: true },
    })
    // The signing secret is never logged, plaintext or encrypted — same
    // reasoning as every other secret in this codebase's audit trail.
    await recordAuditLog(prisma, {
      actorId: request.user.id,
      action: 'webhook_endpoint.created',
      resourceType: 'WebhookEndpoint',
      resourceId: endpoint.id,
      after: { url: endpoint.url, events: endpoint.events, enabled: endpoint.enabled },
      ipAddress: request.ip,
    }, request.log)
    // Return the plaintext secret exactly once so the admin can configure the receiver.
    return reply.status(201).send({ data: { ...endpoint, secret } })
  })

  // PATCH /webhooks/:id — update endpoint
  fastify.patch('/:id', { preHandler: adminGuard }, async (request, reply) => {
    const { id } = request.params as { id: string }
    const result = updateEndpointSchema.safeParse(request.body)
    if (!result.success) {
      return reply.status(400).send({ error: { message: 'Validation failed', code: 'VALIDATION_ERROR', details: result.error.flatten() } })
    }
    const existing = await prisma.webhookEndpoint.findUnique({ where: { id } })
    if (!existing) return reply.status(404).send({ error: { message: 'Webhook endpoint not found', code: 'NOT_FOUND' } })

    if (result.data.url !== undefined) {
      try {
        await assertPublicWebhookUrl(result.data.url)
      } catch (err) {
        return reply.status(400).send({ error: { message: err instanceof Error ? err.message : 'Invalid webhook URL', code: 'INVALID_WEBHOOK_URL' } })
      }
    }

    // Encrypt the secret at rest when it is being rotated.
    const { secret, ...rest } = result.data
    const endpoint = await prisma.webhookEndpoint.update({
      where: { id },
      data: { ...rest, ...(secret !== undefined ? { secret: encrypt(secret) } : {}) },
      select: { id: true, url: true, events: true, enabled: true, consecutiveFailures: true, lastSuccessAt: true, createdAt: true, updatedAt: true },
    })
    await recordAuditLog(prisma, {
      actorId: request.user.id,
      action: 'webhook_endpoint.updated',
      resourceType: 'WebhookEndpoint',
      resourceId: id,
      before: { url: existing.url, events: existing.events, enabled: existing.enabled },
      after: { url: endpoint.url, events: endpoint.events, enabled: endpoint.enabled, secretRotated: secret !== undefined },
      ipAddress: request.ip,
    }, request.log)
    return reply.send({ data: endpoint })
  })

  // DELETE /webhooks/:id — delete endpoint
  fastify.delete('/:id', { preHandler: adminGuard }, async (request, reply) => {
    const { id } = request.params as { id: string }
    const existing = await prisma.webhookEndpoint.findUnique({ where: { id } })
    if (!existing) return reply.status(404).send({ error: { message: 'Webhook endpoint not found', code: 'NOT_FOUND' } })
    await prisma.webhookEndpoint.delete({ where: { id } })
    await recordAuditLog(prisma, {
      actorId: request.user.id,
      action: 'webhook_endpoint.deleted',
      resourceType: 'WebhookEndpoint',
      resourceId: id,
      before: { url: existing.url, events: existing.events, enabled: existing.enabled },
      ipAddress: request.ip,
    }, request.log)
    return reply.send({ data: { ok: true } })
  })

  // POST /webhooks/:id/ping — send a test ping to this endpoint only. Rate
  // limited like other admin actions that make a real outbound request to an
  // admin-chosen URL (see floor-plan upload) — SSRF protection already makes
  // this safe against reaching internal addresses, but nothing previously
  // bounded how many real requests a session could fire at one external URL.
  fastify.post('/:id/ping', { preHandler: adminGuard, config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (request, reply) => {
    const { id } = request.params as { id: string }
    const existing = await prisma.webhookEndpoint.findUnique({ where: { id } })
    if (!existing) return reply.status(404).send({ error: { message: 'Webhook endpoint not found', code: 'NOT_FOUND' } })
    // Deliver a ping to exactly this endpoint — does not touch enabled state and
    // does not fan out to other endpoints.
    await dispatchPing(id)
    // Every other action here (create/update/delete) is audited — a ping is a
    // real outbound request to an admin-chosen URL and was the one action on
    // this resource left with no audit trail at all.
    await recordAuditLog(prisma, {
      actorId: request.user.id,
      action: 'webhook_endpoint.pinged',
      resourceType: 'WebhookEndpoint',
      resourceId: id,
      ipAddress: request.ip,
    }, request.log)
    return reply.send({ data: { ok: true } })
  })

  // GET /webhooks/:id/deliveries — delivery log for an endpoint
  fastify.get('/:id/deliveries', { preHandler: adminGuard }, async (request, reply) => {
    const { id } = request.params as { id: string }
    const { page = '1', limit = '50' } = request.query as Record<string, string>
    const pageNum = Math.max(1, parseInt(page, 10) || 1)
    const limitNum = Math.min(100, Math.max(1, parseInt(limit, 10) || 50))
    const skip = (pageNum - 1) * limitNum

    const existing = await prisma.webhookEndpoint.findUnique({ where: { id } })
    if (!existing) return reply.status(404).send({ error: { message: 'Webhook endpoint not found', code: 'NOT_FOUND' } })

    const [deliveries, total] = await Promise.all([
      prisma.webhookDelivery.findMany({
        where: { endpointId: id },
        orderBy: { createdAt: 'desc' },
        skip,
        take: limitNum,
        select: { id: true, event: true, statusCode: true, success: true, error: true, attempt: true, createdAt: true },
      }),
      prisma.webhookDelivery.count({ where: { endpointId: id } }),
    ])

    return reply.send({
      data: deliveries,
      meta: { total, page: pageNum, limit: limitNum, totalPages: Math.ceil(total / limitNum) },
    })
  })
}
