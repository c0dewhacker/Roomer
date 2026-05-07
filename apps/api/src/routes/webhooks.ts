import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { randomBytes } from 'crypto'
import { prisma } from '../lib/prisma.js'
import { requireAuth } from '../middleware/requireAuth.js'
import { requireGlobalRole } from '../middleware/requireRole.js'
import { GlobalRole } from '@roomer/shared'
import { WEBHOOK_EVENTS } from '../lib/webhook.js'

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
      select: { id: true, url: true, events: true, enabled: true, createdAt: true, updatedAt: true },
    })
    return reply.send({ data: endpoints })
  })

  // POST /webhooks — create endpoint
  fastify.post('/', { preHandler: adminGuard }, async (request, reply) => {
    const result = createEndpointSchema.safeParse(request.body)
    if (!result.success) {
      return reply.status(400).send({ error: { message: 'Validation failed', code: 'VALIDATION_ERROR', details: result.error.flatten() } })
    }
    const secret = result.data.secret ?? randomBytes(32).toString('hex')
    const endpoint = await prisma.webhookEndpoint.create({
      data: {
        url: result.data.url,
        secret,
        events: result.data.events,
        enabled: result.data.enabled ?? true,
      },
    })
    return reply.status(201).send({ data: { ...endpoint } })
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

    const endpoint = await prisma.webhookEndpoint.update({
      where: { id },
      data: result.data,
      select: { id: true, url: true, events: true, enabled: true, createdAt: true, updatedAt: true },
    })
    return reply.send({ data: endpoint })
  })

  // DELETE /webhooks/:id — delete endpoint
  fastify.delete('/:id', { preHandler: adminGuard }, async (request, reply) => {
    const { id } = request.params as { id: string }
    const existing = await prisma.webhookEndpoint.findUnique({ where: { id } })
    if (!existing) return reply.status(404).send({ error: { message: 'Webhook endpoint not found', code: 'NOT_FOUND' } })
    await prisma.webhookEndpoint.delete({ where: { id } })
    return reply.send({ data: { ok: true } })
  })

  // POST /webhooks/:id/ping — send a test ping to an endpoint
  fastify.post('/:id/ping', { preHandler: adminGuard }, async (request, reply) => {
    const { id } = request.params as { id: string }
    const existing = await prisma.webhookEndpoint.findUnique({ where: { id } })
    if (!existing) return reply.status(404).send({ error: { message: 'Webhook endpoint not found', code: 'NOT_FOUND' } })
    const { dispatchWebhook } = await import('../lib/webhook.js')
    // Temporarily use the endpoint directly regardless of enabled state
    const { prisma: db } = await import('../lib/prisma.js')
    // Re-enable temporarily if disabled so dispatchWebhook finds it
    const wasDisabled = !existing.enabled
    if (wasDisabled) await db.webhookEndpoint.update({ where: { id }, data: { enabled: true } })
    try {
      await dispatchWebhook('booking.created', { ping: true, endpointId: id })
    } finally {
      if (wasDisabled) await db.webhookEndpoint.update({ where: { id }, data: { enabled: false } })
    }
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
