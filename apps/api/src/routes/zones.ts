import type { FastifyInstance } from 'fastify'
import { prisma } from '../lib/prisma.js'
import { createZoneSchema, updateZoneSchema, createZoneGroupSchema, updateZoneGroupSchema, GlobalRole } from '@roomer/shared'
import { requireAuth } from '../middleware/requireAuth.js'
import { isFloorManagerForFloor } from '../middleware/requireRole.js'
import { cancelFutureBookingsForAssets } from '../lib/queue.js'

export async function zoneRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.addHook('onRoute', (route) => { route.schema = { tags: ['Zones'], ...route.schema } })

  // POST /zones — create zone (SUPER_ADMIN or floor manager for the target floor)
  fastify.post(
    '/',
    { preHandler: [requireAuth] },
    async (request, reply) => {
      const result = createZoneSchema.safeParse(request.body)
      if (!result.success) {
        return reply.status(400).send({
          error: { message: 'Validation failed', code: 'VALIDATION_ERROR', details: result.error.flatten() },
        })
      }

      if (request.user.globalRole !== GlobalRole.SUPER_ADMIN) {
        const canManage = await isFloorManagerForFloor(request.user.id, result.data.floorId)
        if (!canManage) {
          return reply.status(403).send({ error: { message: 'Insufficient permissions', code: 'FORBIDDEN' } })
        }
      }

      const floor = await prisma.floor.findUnique({ where: { id: result.data.floorId } })
      if (!floor) {
        return reply.status(404).send({ error: { message: 'Floor not found', code: 'NOT_FOUND' } })
      }

      if (result.data.zoneGroupId) {
        const group = await prisma.zoneGroup.findUnique({ where: { id: result.data.zoneGroupId } })
        if (!group || group.floorId !== result.data.floorId) {
          return reply.status(404).send({
            error: { message: 'Zone group not found on this floor', code: 'NOT_FOUND' },
          })
        }
      }

      const zone = await prisma.zone.create({
        data: {
          floorId: result.data.floorId,
          name: result.data.name,
          colour: result.data.colour ?? '#6366f1',
          zoneGroupId: result.data.zoneGroupId ?? null,
        },
      })

      return reply.status(201).send({ data: zone })
    },
  )

  // PUT /zones/:id — update zone (SUPER_ADMIN or floor manager for the zone's floor)
  fastify.put(
    '/:id',
    { preHandler: [requireAuth] },
    async (request, reply) => {
      const { id } = request.params as { id: string }
      const result = updateZoneSchema.safeParse(request.body)
      if (!result.success) {
        return reply.status(400).send({
          error: { message: 'Validation failed', code: 'VALIDATION_ERROR', details: result.error.flatten() },
        })
      }

      const existing = await prisma.zone.findUnique({ where: { id }, select: { floorId: true } })
      if (!existing) {
        return reply.status(404).send({ error: { message: 'Zone not found', code: 'NOT_FOUND' } })
      }

      if (request.user.globalRole !== GlobalRole.SUPER_ADMIN) {
        const canManage = await isFloorManagerForFloor(request.user.id, existing.floorId)
        if (!canManage) {
          return reply.status(403).send({ error: { message: 'Insufficient permissions', code: 'FORBIDDEN' } })
        }
      }

      // A zone group must belong to the same floor as the zone — otherwise a
      // zone ends up grouped with unrelated zones on a different floor plan,
      // and (for non-admins) this would let a manager for this zone's floor
      // reach into a zone group on a floor they don't manage.
      if (result.data.zoneGroupId) {
        const group = await prisma.zoneGroup.findUnique({ where: { id: result.data.zoneGroupId } })
        if (!group || group.floorId !== existing.floorId) {
          return reply.status(404).send({
            error: { message: 'Zone group not found on this floor', code: 'NOT_FOUND' },
          })
        }
      }

      try {
        const zone = await prisma.zone.update({ where: { id }, data: result.data })
        return reply.status(200).send({ data: zone })
      } catch {
        return reply.status(404).send({ error: { message: 'Zone not found', code: 'NOT_FOUND' } })
      }
    },
  )

  // DELETE /zones/:id (SUPER_ADMIN or floor manager for the zone's floor)
  fastify.delete(
    '/:id',
    { preHandler: [requireAuth] },
    async (request, reply) => {
      const { id } = request.params as { id: string }

      const existing = await prisma.zone.findUnique({ where: { id }, select: { floorId: true } })
      if (!existing) {
        return reply.status(404).send({ error: { message: 'Zone not found', code: 'NOT_FOUND' } })
      }

      if (request.user.globalRole !== GlobalRole.SUPER_ADMIN) {
        const canManage = await isFloorManagerForFloor(request.user.id, existing.floorId)
        if (!canManage) {
          return reply.status(403).send({ error: { message: 'Insufficient permissions', code: 'FORBIDDEN' } })
        }
      }

      // A zone's assets have nowhere to go once it's deleted — Asset.primaryZoneId
      // SetNulls automatically, but the asset otherwise keeps its floorId/x/y and
      // silently vanishes from both the floor admin page and the floor plan
      // canvas (both group strictly by zone, with no "unzoned" fallback — see
      // issue #206), while not qualifying as "unplaced" either since floorId is
      // still set. Unplace them the same way "Remove from floor plan" already
      // does for a single asset, so they correctly reappear in the unplaced pool
      // instead of falling into a gap no admin screen can reach. Cancel their
      // future bookings first, before they become unreachable from any floor.
      const zoneAssets = await prisma.asset.findMany({ where: { primaryZoneId: id }, select: { id: true } })
      const zoneAssetIds = zoneAssets.map((a) => a.id)
      await cancelFutureBookingsForAssets(zoneAssetIds)
      if (zoneAssetIds.length > 0) {
        await prisma.asset.updateMany({
          where: { id: { in: zoneAssetIds } },
          data: { floorId: null, primaryZoneId: null, x: null, y: null },
        })
      }

      // Deleting a zone must not silently widen an existing subscription from
      // "notify me about this zone" to "notify me about the whole floor" —
      // FloorSubscriptionZone cascades away on zone delete, and an empty
      // zones relation on a FloorSubscription means "match all zones" (see
      // handleFloorSubscriptions in queue.ts), so a subscription whose only
      // zone was this one would otherwise start firing floor-wide with no
      // signal to the subscriber. Delete those subscriptions outright instead;
      // subscriptions that also reference other zones are unaffected — the
      // cascade just narrows their scope, which is correct.
      const soleZoneSubs = await prisma.floorSubscription.findMany({
        where: { zones: { every: { zoneId: id }, some: {} } },
        select: { id: true },
      })
      if (soleZoneSubs.length > 0) {
        await prisma.floorSubscription.deleteMany({ where: { id: { in: soleZoneSubs.map((s) => s.id) } } })
      }

      try {
        await prisma.zone.delete({ where: { id } })
        return reply.status(200).send({ data: { ok: true } })
      } catch {
        return reply.status(404).send({ error: { message: 'Zone not found', code: 'NOT_FOUND' } })
      }
    },
  )
}

export async function zoneGroupRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.addHook('onRoute', (route) => { route.schema = { tags: ['Zones'], ...route.schema } })

  // POST /zone-groups — create zone group (SUPER_ADMIN or floor manager for the target floor)
  fastify.post(
    '/',
    { preHandler: [requireAuth] },
    async (request, reply) => {
      const result = createZoneGroupSchema.safeParse(request.body)
      if (!result.success) {
        return reply.status(400).send({
          error: { message: 'Validation failed', code: 'VALIDATION_ERROR', details: result.error.flatten() },
        })
      }

      if (request.user.globalRole !== GlobalRole.SUPER_ADMIN) {
        const canManage = await isFloorManagerForFloor(request.user.id, result.data.floorId)
        if (!canManage) {
          return reply.status(403).send({ error: { message: 'Insufficient permissions', code: 'FORBIDDEN' } })
        }
      }

      const floor = await prisma.floor.findUnique({ where: { id: result.data.floorId } })
      if (!floor) {
        return reply.status(404).send({ error: { message: 'Floor not found', code: 'NOT_FOUND' } })
      }

      const group = await prisma.zoneGroup.create({
        data: {
          floorId: result.data.floorId,
          name: result.data.name,
        },
      })

      return reply.status(201).send({ data: group })
    },
  )

  // PUT /zone-groups/:id — rename (SUPER_ADMIN or floor manager for the group's floor)
  fastify.put(
    '/:id',
    { preHandler: [requireAuth] },
    async (request, reply) => {
      const { id } = request.params as { id: string }
      const result = updateZoneGroupSchema.safeParse(request.body)
      if (!result.success) {
        return reply.status(400).send({
          error: { message: 'Validation failed', code: 'VALIDATION_ERROR', details: result.error.flatten() },
        })
      }

      const existing = await prisma.zoneGroup.findUnique({ where: { id }, select: { floorId: true } })
      if (!existing) {
        return reply.status(404).send({ error: { message: 'Zone group not found', code: 'NOT_FOUND' } })
      }

      if (request.user.globalRole !== GlobalRole.SUPER_ADMIN) {
        const canManage = await isFloorManagerForFloor(request.user.id, existing.floorId)
        if (!canManage) {
          return reply.status(403).send({ error: { message: 'Insufficient permissions', code: 'FORBIDDEN' } })
        }
      }

      const group = await prisma.zoneGroup.update({ where: { id }, data: { name: result.data.name } })
      return reply.status(200).send({ data: group })
    },
  )

  // DELETE /zone-groups/:id (SUPER_ADMIN or floor manager for the group's floor)
  fastify.delete(
    '/:id',
    { preHandler: [requireAuth] },
    async (request, reply) => {
      const { id } = request.params as { id: string }

      if (request.user.globalRole !== GlobalRole.SUPER_ADMIN) {
        const existing = await prisma.zoneGroup.findUnique({ where: { id }, select: { floorId: true } })
        if (!existing) {
          return reply.status(404).send({ error: { message: 'Zone group not found', code: 'NOT_FOUND' } })
        }
        const canManage = await isFloorManagerForFloor(request.user.id, existing.floorId)
        if (!canManage) {
          return reply.status(403).send({ error: { message: 'Insufficient permissions', code: 'FORBIDDEN' } })
        }
      }

      try {
        await prisma.zoneGroup.delete({ where: { id } })
        return reply.status(200).send({ data: { ok: true } })
      } catch {
        return reply.status(404).send({ error: { message: 'Zone group not found', code: 'NOT_FOUND' } })
      }
    },
  )
}
