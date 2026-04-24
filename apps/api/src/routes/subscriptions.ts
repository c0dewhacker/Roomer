import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { prisma } from '../lib/prisma'
import { requireAuth } from '../middleware/requireAuth'

const createSchema = z.object({
  floorId: z.string().min(1),
  zoneIds: z.array(z.string().min(1)).optional(),
})

const updateSchema = z.object({
  zoneIds: z.array(z.string().min(1)),
})

export async function subscriptionRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.addHook('onRoute', (route) => { route.schema = { tags: ['Subscriptions'], ...route.schema } })

  // GET /subscriptions — list current user's floor subscriptions
  fastify.get('/', { preHandler: [requireAuth] }, async (request, reply) => {
    const subs = await prisma.floorSubscription.findMany({
      where: { userId: request.user.id },
      include: {
        floor: { select: { id: true, name: true, building: { select: { id: true, name: true } } } },
        zones: { include: { zone: { select: { id: true, name: true, colour: true } } } },
      },
      orderBy: { createdAt: 'asc' },
    })
    return reply.status(200).send({ data: subs })
  })

  // POST /subscriptions — subscribe to a floor (optionally specific zones)
  fastify.post('/', { preHandler: [requireAuth] }, async (request, reply) => {
    const result = createSchema.safeParse(request.body)
    if (!result.success) {
      return reply.status(400).send({
        error: { message: 'Validation failed', code: 'VALIDATION_ERROR', details: result.error.flatten() },
      })
    }

    const { floorId, zoneIds } = result.data

    const floor = await prisma.floor.findUnique({ where: { id: floorId } })
    if (!floor) {
      return reply.status(404).send({ error: { message: 'Floor not found', code: 'NOT_FOUND' } })
    }

    // Validate zone IDs belong to this floor
    if (zoneIds && zoneIds.length > 0) {
      const zones = await prisma.zone.findMany({
        where: { id: { in: zoneIds }, floorId },
        select: { id: true },
      })
      if (zones.length !== zoneIds.length) {
        return reply.status(400).send({
          error: { message: 'One or more zone IDs are invalid for this floor', code: 'INVALID_ZONES' },
        })
      }
    }

    // Upsert subscription — if one exists, replace its zones
    const existing = await prisma.floorSubscription.findUnique({
      where: { userId_floorId: { userId: request.user.id, floorId } },
    })

    let sub
    if (existing) {
      // Delete existing zones and replace
      await prisma.floorSubscriptionZone.deleteMany({ where: { subscriptionId: existing.id } })
      if (zoneIds && zoneIds.length > 0) {
        await prisma.floorSubscriptionZone.createMany({
          data: zoneIds.map((zoneId) => ({ subscriptionId: existing.id, zoneId })),
        })
      }
      sub = await prisma.floorSubscription.findUnique({
        where: { id: existing.id },
        include: {
          floor: { select: { id: true, name: true, building: { select: { id: true, name: true } } } },
          zones: { include: { zone: { select: { id: true, name: true, colour: true } } } },
        },
      })
      return reply.status(200).send({ data: sub })
    }

    sub = await prisma.floorSubscription.create({
      data: {
        userId: request.user.id,
        floorId,
        zones: zoneIds && zoneIds.length > 0
          ? { create: zoneIds.map((zoneId) => ({ zoneId })) }
          : undefined,
      },
      include: {
        floor: { select: { id: true, name: true, building: { select: { id: true, name: true } } } },
        zones: { include: { zone: { select: { id: true, name: true, colour: true } } } },
      },
    })

    return reply.status(201).send({ data: sub })
  })

  // PUT /subscriptions/:id — update zone selection
  fastify.put('/:id', { preHandler: [requireAuth] }, async (request, reply) => {
    const { id } = request.params as { id: string }
    const result = updateSchema.safeParse(request.body)
    if (!result.success) {
      return reply.status(400).send({
        error: { message: 'Validation failed', code: 'VALIDATION_ERROR', details: result.error.flatten() },
      })
    }

    const sub = await prisma.floorSubscription.findUnique({ where: { id } })
    if (!sub) {
      return reply.status(404).send({ error: { message: 'Subscription not found', code: 'NOT_FOUND' } })
    }
    if (sub.userId !== request.user.id) {
      return reply.status(403).send({ error: { message: 'Forbidden', code: 'FORBIDDEN' } })
    }

    const { zoneIds } = result.data

    if (zoneIds.length > 0) {
      const zones = await prisma.zone.findMany({
        where: { id: { in: zoneIds }, floorId: sub.floorId },
        select: { id: true },
      })
      if (zones.length !== zoneIds.length) {
        return reply.status(400).send({
          error: { message: 'One or more zone IDs are invalid for this floor', code: 'INVALID_ZONES' },
        })
      }
    }

    await prisma.floorSubscriptionZone.deleteMany({ where: { subscriptionId: id } })
    if (zoneIds.length > 0) {
      await prisma.floorSubscriptionZone.createMany({
        data: zoneIds.map((zoneId) => ({ subscriptionId: id, zoneId })),
      })
    }

    const updated = await prisma.floorSubscription.findUnique({
      where: { id },
      include: {
        floor: { select: { id: true, name: true, building: { select: { id: true, name: true } } } },
        zones: { include: { zone: { select: { id: true, name: true, colour: true } } } },
      },
    })
    return reply.status(200).send({ data: updated })
  })

  // DELETE /subscriptions/:id — unsubscribe
  fastify.delete('/:id', { preHandler: [requireAuth] }, async (request, reply) => {
    const { id } = request.params as { id: string }

    const sub = await prisma.floorSubscription.findUnique({ where: { id } })
    if (!sub) {
      return reply.status(404).send({ error: { message: 'Subscription not found', code: 'NOT_FOUND' } })
    }
    if (sub.userId !== request.user.id) {
      return reply.status(403).send({ error: { message: 'Forbidden', code: 'FORBIDDEN' } })
    }

    await prisma.floorSubscription.delete({ where: { id } })
    return reply.status(200).send({ data: { ok: true } })
  })
}
