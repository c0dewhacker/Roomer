import type { FastifyInstance } from 'fastify'
import { prisma } from '../lib/prisma.js'
import { createZoneSchema, updateZoneSchema, createZoneGroupSchema, updateZoneGroupSchema, GlobalRole } from '@roomer/shared'
import { requireAuth } from '../middleware/requireAuth.js'
import { isFloorManagerForFloor } from '../middleware/requireRole.js'
import { cancelFutureBookingsForAssets } from '../lib/queue.js'
import { recordAuditLog } from '../lib/audit.js'

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
      await recordAuditLog(prisma, {
        actorId: request.user.id,
        action: 'zone.created',
        resourceType: 'Zone',
        resourceId: zone.id,
        after: { floorId: zone.floorId, name: zone.name, colour: zone.colour, zoneGroupId: zone.zoneGroupId },
        ipAddress: request.ip,
      }, request.log)

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
        const before = await prisma.zone.findUnique({ where: { id }, select: { name: true, colour: true, zoneGroupId: true } })
        const zone = await prisma.zone.update({ where: { id }, data: result.data })
        await recordAuditLog(prisma, {
          actorId: request.user.id,
          action: 'zone.updated',
          resourceType: 'Zone',
          resourceId: id,
          before,
          after: { name: zone.name, colour: zone.colour, zoneGroupId: zone.zoneGroupId },
          ipAddress: request.ip,
        }, request.log)
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
      // instead of falling into a gap no admin screen can reach.
      //
      // The snapshot of "assets in this zone" and the zone delete itself run
      // inside one transaction, locking the zone row first — a concurrent
      // PATCH /assets/:id that re-zones an asset into this zone needs an FK
      // check against that same row, so Postgres blocks it until we commit,
      // then it fails outright (the zone being gone) instead of racing our
      // snapshot and surviving deletion with floorId/x/y intact but no zone,
      // reproducing the exact #206 gap this unplace step exists to prevent.
      const result = await prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM "Zone" WHERE id = ${id} FOR UPDATE`

        const zoneAssets = await tx.asset.findMany({ where: { primaryZoneId: id }, select: { id: true } })
        const zoneAssetIds = zoneAssets.map((a) => a.id)
        if (zoneAssetIds.length > 0) {
          await tx.asset.updateMany({
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
        const soleZoneSubs = await tx.floorSubscription.findMany({
          where: { zones: { every: { zoneId: id }, some: {} } },
          select: { id: true },
        })
        if (soleZoneSubs.length > 0) {
          await tx.floorSubscription.deleteMany({ where: { id: { in: soleZoneSubs.map((s) => s.id) } } })
        }

        const deleted = await tx.zone.delete({ where: { id } })
        return { deleted, zoneAssetIds }
      }).catch(() => null)

      if (!result) {
        return reply.status(404).send({ error: { message: 'Zone not found', code: 'NOT_FOUND' } })
      }

      // Cancel bookings on the assets that were actually in the zone at the
      // moment of deletion (per the lock above, not a pre-lock snapshot) —
      // done outside the transaction since it dispatches webhooks/notification
      // jobs, not just DB writes.
      await cancelFutureBookingsForAssets(result.zoneAssetIds)

      await recordAuditLog(prisma, {
        actorId: request.user.id,
        action: 'zone.deleted',
        resourceType: 'Zone',
        resourceId: id,
        before: { floorId: result.deleted.floorId, name: result.deleted.name, colour: result.deleted.colour, zoneGroupId: result.deleted.zoneGroupId },
        ipAddress: request.ip,
      }, request.log)
      return reply.status(200).send({ data: { ok: true } })
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
      await recordAuditLog(prisma, {
        actorId: request.user.id,
        action: 'zone_group.created',
        resourceType: 'ZoneGroup',
        resourceId: group.id,
        after: { floorId: group.floorId, name: group.name },
        ipAddress: request.ip,
      }, request.log)

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

      const existing = await prisma.zoneGroup.findUnique({ where: { id }, select: { floorId: true, name: true } })
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
      await recordAuditLog(prisma, {
        actorId: request.user.id,
        action: 'zone_group.updated',
        resourceType: 'ZoneGroup',
        resourceId: id,
        before: { name: existing.name },
        after: { name: group.name },
        ipAddress: request.ip,
      }, request.log)
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
        const deleted = await prisma.zoneGroup.delete({ where: { id } })
        await recordAuditLog(prisma, {
          actorId: request.user.id,
          action: 'zone_group.deleted',
          resourceType: 'ZoneGroup',
          resourceId: id,
          before: { floorId: deleted.floorId, name: deleted.name },
          ipAddress: request.ip,
        }, request.log)
        return reply.status(200).send({ data: { ok: true } })
      } catch {
        return reply.status(404).send({ error: { message: 'Zone group not found', code: 'NOT_FOUND' } })
      }
    },
  )
}
