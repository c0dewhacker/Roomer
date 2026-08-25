import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { Prisma } from '@prisma/client'
import { prisma } from '../lib/prisma.js'
import { requireAuth } from '../middleware/requireAuth.js'
import { checkGroupAccess } from './groups.js'
import { recordAuditLog } from '../lib/audit.js'

const subscriptionInclude = {
  floor: { select: { id: true, name: true, building: { select: { id: true, name: true } } } },
  zones: { include: { zone: { select: { id: true, name: true, colour: true } } } },
} as const

// Replaces a subscription's zone set atomically. Wrapping delete+recreate in
// a transaction alone is not enough: under READ COMMITTED, neither
// transaction's INSERT conflicts with the other's DELETE, so two concurrent
// replace requests for the same subscription can still interleave (A
// deletes, B deletes, B inserts, A inserts) and leave the union of both zone
// sets instead of either one. Explicitly locking the parent row first forces
// the second transaction to wait for the first to fully commit before it
// reads/deletes/inserts anything, so the result is always a clean replace.
async function replaceSubscriptionZones(subscriptionId: string, zoneIds: string[]) {
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "FloorSubscription" WHERE id = ${subscriptionId} FOR UPDATE`
    await tx.floorSubscriptionZone.deleteMany({ where: { subscriptionId } })
    if (zoneIds.length > 0) {
      await tx.floorSubscriptionZone.createMany({
        data: zoneIds.map((zoneId) => ({ subscriptionId, zoneId })),
      })
    }
    return tx.floorSubscription.findUniqueOrThrow({
      where: { id: subscriptionId },
      include: subscriptionInclude,
    })
  })
}

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
      include: subscriptionInclude,
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

    const canAccess = await checkGroupAccess(request.user.id, floor.buildingId, floorId)
    if (!canAccess) {
      return reply.status(403).send({ error: { message: 'Your group does not have access to this floor', code: 'GROUP_ACCESS_DENIED' } })
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

    if (existing) {
      const sub = await replaceSubscriptionZones(existing.id, zoneIds ?? [])
      await recordAuditLog(prisma, {
        actorId: request.user.id,
        action: 'floor_subscription.updated',
        resourceType: 'FloorSubscription',
        resourceId: existing.id,
        after: { floorId, zoneIds: zoneIds ?? [] },
        ipAddress: request.ip,
      }, request.log)
      return reply.status(200).send({ data: sub })
    }

    let created
    try {
      created = await prisma.floorSubscription.create({
        data: {
          userId: request.user.id,
          floorId,
          zones: zoneIds && zoneIds.length > 0
            ? { create: zoneIds.map((zoneId) => ({ zoneId })) }
            : undefined,
        },
        include: subscriptionInclude,
      })
    } catch (err) {
      // Two concurrent first-time subscribes for the same user+floor both see
      // `existing === null` and both attempt create — the second hits the
      // userId_floorId unique constraint. Treat it the same as the existing-
      // subscription branch above rather than surfacing a raw 500.
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        const raced = await prisma.floorSubscription.findUniqueOrThrow({
          where: { userId_floorId: { userId: request.user.id, floorId } },
        })
        const sub = await replaceSubscriptionZones(raced.id, zoneIds ?? [])
        await recordAuditLog(prisma, {
          actorId: request.user.id,
          action: 'floor_subscription.updated',
          resourceType: 'FloorSubscription',
          resourceId: raced.id,
          after: { floorId, zoneIds: zoneIds ?? [] },
          ipAddress: request.ip,
        }, request.log)
        return reply.status(200).send({ data: sub })
      }
      throw err
    }

    await recordAuditLog(prisma, {
      actorId: request.user.id,
      action: 'floor_subscription.created',
      resourceType: 'FloorSubscription',
      resourceId: created.id,
      after: { floorId, zoneIds: zoneIds ?? [] },
      ipAddress: request.ip,
    }, request.log)

    return reply.status(201).send({ data: created })
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

    const updated = await replaceSubscriptionZones(id, zoneIds)
    await recordAuditLog(prisma, {
      actorId: request.user.id,
      action: 'floor_subscription.updated',
      resourceType: 'FloorSubscription',
      resourceId: id,
      after: { zoneIds },
      ipAddress: request.ip,
    }, request.log)
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
    await recordAuditLog(prisma, {
      actorId: request.user.id,
      action: 'floor_subscription.deleted',
      resourceType: 'FloorSubscription',
      resourceId: id,
      before: { floorId: sub.floorId },
      ipAddress: request.ip,
    }, request.log)
    return reply.status(200).send({ data: { ok: true } })
  })
}
