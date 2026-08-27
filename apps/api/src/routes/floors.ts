import fs from 'fs'
import path from 'path'
import type { FastifyInstance } from 'fastify'
import type { Prisma } from '@prisma/client'
import { prisma } from '../lib/prisma.js'
import { createFloorSchema, updateFloorSchema, GlobalRole } from '@roomer/shared'
import { requireAuth } from '../middleware/requireAuth.js'
import { isFloorManagerForFloor, isBuildingManagerForBuilding, RESOURCE_ROLE_GRANT_LOCK_CLASS } from '../middleware/requireRole.js'
import { saveFloorPlan, resolveStoragePath, deleteFile } from '../lib/storage.js'
import { checkGroupAccess } from './groups.js'
import { cancelFutureBookingsForFloors, cancelQueueEntriesForFloors } from '../lib/queue.js'
import { recordAuditLog } from '../lib/audit.js'
import { zonedWallClockToUtc } from '../lib/timezone.js'
import { z } from 'zod'

/**
 * Merge a zone's primary-membership assets with its secondary (AssetZone)
 * memberships into one per-zone list, tagging each with isPrimaryZone so the
 * frontend canvas — which renders one marker per asset at its single x/y —
 * can de-duplicate an asset appearing under more than one zone rather than
 * drawing it twice. Previously only `zone.assets` (the primary-zone
 * relation) was ever read anywhere; AssetZone rows had a full CRUD API and
 * an admin UI (DeskPanel.tsx) but zero effect on the floor plan or
 * availability (see #224) — a shared asset (e.g. a meeting room spanning two
 * team zones) never appeared in the second zone's list at all.
 */
function mergeZoneAssets<T extends { id: string }>(
  primaryAssets: T[],
  secondaryMemberships: Array<{ asset: T }>,
): Array<T & { isPrimaryZone: boolean }> {
  const primaryIds = new Set(primaryAssets.map((a) => a.id))
  const merged: Array<T & { isPrimaryZone: boolean }> = primaryAssets.map((a) => ({ ...a, isPrimaryZone: true }))
  for (const { asset } of secondaryMemberships) {
    if (primaryIds.has(asset.id)) continue // create already rejects primary-as-secondary; defensive only
    merged.push({ ...asset, isPrimaryZone: false })
  }
  return merged
}

export async function floorRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.addHook('onRoute', (route) => { route.schema = { tags: ['Floors'], ...route.schema } })

  // GET /floors/:id/access-summary — "who can access / manage this floor?"
  // SUPER_ADMIN, building admin, or floor manager for this floor —
  // isFloorManagerForFloor already treats building admins as inheriting
  // floor-manager access, so this one check covers both. FloorAdminPage
  // routes all three onto the page this powers via BuildingManagerOrAdminRoute,
  // so this was silently 403ing for anyone who wasn't a literal SUPER_ADMIN.
  fastify.get('/:id/access-summary', { preHandler: [requireAuth] }, async (request, reply) => {
    const { id } = request.params as { id: string }

    if (request.user.globalRole !== GlobalRole.SUPER_ADMIN) {
      const canManage = await isFloorManagerForFloor(request.user.id, id)
      if (!canManage) {
        return reply.status(403).send({ error: { message: 'Insufficient permissions', code: 'FORBIDDEN' } })
      }
    }

    const floor = await prisma.floor.findUnique({
      where: { id },
      select: { id: true, name: true, building: { select: { id: true, name: true } } },
    })
    if (!floor) return reply.status(404).send({ error: { message: 'Floor not found', code: 'NOT_FOUND' } })

    const [accessGroups, directManagers, groupManagers, buildingAdmins] = await Promise.all([
      prisma.groupFloorAccess.findMany({ where: { floorId: id }, select: { group: { select: { id: true, name: true } } } }),
      prisma.userResourceRole.findMany({
        where: { scopeType: 'FLOOR', floorId: id, role: 'FLOOR_MANAGER' },
        select: { source: true, user: { select: { id: true, displayName: true, email: true } } },
      }),
      prisma.groupResourceRole.findMany({
        where: { scopeType: 'FLOOR', floorId: id, role: 'FLOOR_MANAGER' },
        select: { source: true, group: { select: { id: true, name: true, _count: { select: { members: true } } } } },
      }),
      // Building admins inherit floor-manager rights on every floor in their building
      prisma.userResourceRole.findMany({
        where: { scopeType: 'BUILDING', buildingId: floor.building.id, role: 'BUILDING_ADMIN' },
        select: { user: { select: { id: true, displayName: true, email: true } } },
      }),
    ])

    return reply.status(200).send({
      data: {
        floorId: floor.id,
        name: floor.name,
        building: floor.building,
        access: {
          restricted: accessGroups.length > 0,
          groups: accessGroups.map((a) => a.group),
        },
        managers: {
          direct: directManagers.map((m) => ({ ...m.user, source: m.source })),
          viaGroups: groupManagers.map((m) => ({ ...m.group, memberCount: m.group._count.members, source: m.source })),
          inheritedFromBuildingAdmins: buildingAdmins.map((m) => m.user),
        },
      },
    })
  })

  // GET /floors/:id — floor with zones, bookable assets, floorPlan
  fastify.get('/:id', { preHandler: [requireAuth] }, async (request, reply) => {
    const { id } = request.params as { id: string }

    const floor = await prisma.floor.findUnique({
      where: { id },
      include: {
        building: { select: { id: true, name: true } },
        floorPlan: true,
        zoneGroups: { orderBy: { name: 'asc' } },
        zones: {
          orderBy: { name: 'asc' },
          include: {
            assets: {
              where: { isBookable: true },
              orderBy: { name: 'asc' },
              include: {
                category: { select: { id: true, name: true, defaultIcon: true, colour: true, iconUrl: true } },
              },
            },
            assetZones: {
              where: { asset: { isBookable: true } },
              include: {
                asset: {
                  include: {
                    category: { select: { id: true, name: true, defaultIcon: true, colour: true, iconUrl: true } },
                  },
                },
              },
            },
          },
        },
      },
    })

    if (!floor) {
      return reply.status(404).send({ error: { message: 'Floor not found', code: 'NOT_FOUND' } })
    }

    if (request.user.globalRole !== GlobalRole.SUPER_ADMIN) {
      const hasAccess = await checkGroupAccess(request.user.id, floor.building.id, id)
      if (!hasAccess) {
        return reply.status(403).send({ error: { message: 'You do not have access to this floor', code: 'FORBIDDEN' } })
      }
    }

    // Transform category iconUrl storage paths to serve URLs
    const floorWithServeUrls = {
      ...floor,
      zones: floor.zones.map((zone) => {
        const { assetZones: _assetZones, ...zoneRest } = zone
        return {
          ...zoneRest,
          assets: mergeZoneAssets(zone.assets, zone.assetZones).map((asset) => ({
            ...asset,
            category: asset.category
              ? {
                  ...asset.category,
                  iconUrl: asset.category.iconUrl
                    ? `/api/v1/assets/categories/${asset.category.id}/icon`
                    : null,
                }
              : null,
          })),
        }
      }),
    }

    return reply.status(200).send({ data: floorWithServeUrls })
  })

  // GET /floors/:id/managers — list floor managers (SUPER_ADMIN, building
  // admin, or a manager of this specific floor — this only checked building
  // admin, so a pure floor manager with no building-wide role couldn't see
  // even their own floor's manager list)
  fastify.get(
    '/:id/managers',
    { preHandler: [requireAuth] },
    async (request, reply) => {
      const { id } = request.params as { id: string }

      if (request.user.globalRole !== GlobalRole.SUPER_ADMIN) {
        const floor = await prisma.floor.findUnique({ where: { id }, select: { buildingId: true } })
        if (!floor) {
          return reply.status(404).send({ error: { message: 'Floor not found', code: 'NOT_FOUND' } })
        }
        const ok = await isFloorManagerForFloor(request.user.id, id)
        if (!ok) {
          return reply.status(403).send({ error: { message: 'Insufficient permissions', code: 'FORBIDDEN' } })
        }
      }

      const roles = await prisma.userResourceRole.findMany({
        where: { scopeType: 'FLOOR', floorId: id, role: 'FLOOR_MANAGER' },
        include: {
          user: { select: { id: true, displayName: true, email: true } },
        },
        orderBy: { createdAt: 'asc' },
      })

      return reply.status(200).send({ data: roles.map((r) => ({ roleId: r.id, ...r.user })) })
    },
  )

  // GET /floors/:id/group-managers — list group floor managers (SUPER_ADMIN,
  // building admin, or a manager of this specific floor — see /managers above)
  fastify.get(
    '/:id/group-managers',
    { preHandler: [requireAuth] },
    async (request, reply) => {
      const { id } = request.params as { id: string }

      if (request.user.globalRole !== GlobalRole.SUPER_ADMIN) {
        const floor = await prisma.floor.findUnique({ where: { id }, select: { buildingId: true } })
        if (!floor) {
          return reply.status(404).send({ error: { message: 'Floor not found', code: 'NOT_FOUND' } })
        }
        const ok = await isFloorManagerForFloor(request.user.id, id)
        if (!ok) {
          return reply.status(403).send({ error: { message: 'Insufficient permissions', code: 'FORBIDDEN' } })
        }
      }

      const roles = await prisma.groupResourceRole.findMany({
        where: { scopeType: 'FLOOR', floorId: id, role: 'FLOOR_MANAGER' },
        include: {
          group: { select: { id: true, name: true, _count: { select: { members: true } } } },
        },
        orderBy: { createdAt: 'asc' },
      })

      return reply.status(200).send({
        data: roles.map((r) => ({
          roleId: r.id,
          id: r.group.id,
          name: r.group.name,
          memberCount: r.group._count.members,
        })),
      })
    },
  )

  // POST /floors/:id/group-managers — assign a group as floor manager (SUPER_ADMIN or building admin)
  fastify.post(
    '/:id/group-managers',
    { preHandler: [requireAuth] },
    async (request, reply) => {
      const { id } = request.params as { id: string }
      // Looked up unconditionally, not just in the non-SUPER_ADMIN branch —
      // groupResourceRole.create below has a real FK on floorId with no
      // try/catch around it, so a SUPER_ADMIN hitting this with a bogus floor
      // id previously fell straight through to an unhandled FK-violation 500
      // instead of a clean 404.
      const floor = await prisma.floor.findUnique({ where: { id }, select: { buildingId: true } })
      if (!floor) return reply.status(404).send({ error: { message: 'Floor not found', code: 'NOT_FOUND' } })
      if (request.user.globalRole !== GlobalRole.SUPER_ADMIN) {
        const canManage = await isBuildingManagerForBuilding(request.user.id, floor.buildingId)
        if (!canManage) return reply.status(403).send({ error: { message: 'Insufficient permissions', code: 'FORBIDDEN' } })
      }
      const bodyResult = z.object({ groupId: z.string().min(1) }).safeParse(request.body)
      if (!bodyResult.success) {
        return reply.status(400).send({ error: { message: 'groupId is required', code: 'VALIDATION_ERROR' } })
      }
      const { groupId } = bodyResult.data

      const group = await prisma.userGroup.findUnique({ where: { id: groupId } })
      if (!group) {
        return reply.status(404).send({ error: { message: 'Group not found', code: 'NOT_FOUND' } })
      }

      // See RESOURCE_ROLE_GRANT_LOCK_CLASS's doc comment — the find-then-create
      // below needs a lock, not just the pre-check, since GroupResourceRole's
      // unique constraint never actually fires for either scope.
      const role = await prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(${RESOURCE_ROLE_GRANT_LOCK_CLASS}, hashtext(${`${groupId}:FLOOR:${id}`}))`
        const existing = await tx.groupResourceRole.findFirst({
          where: { groupId, scopeType: 'FLOOR', floorId: id },
        })
        if (existing) {
          throw Object.assign(new Error('ALREADY_EXISTS'), { code: 'ALREADY_EXISTS' })
        }
        return tx.groupResourceRole.create({
          data: { groupId, role: 'FLOOR_MANAGER', scopeType: 'FLOOR', floorId: id },
        })
      }).catch((err) => {
        if ((err as { code?: string })?.code === 'ALREADY_EXISTS') return null
        throw err
      })
      if (!role) {
        return reply.status(409).send({ error: { message: 'Group is already a floor manager', code: 'ALREADY_EXISTS' } })
      }
      await recordAuditLog(prisma, {
        actorId: request.user.id,
        action: 'group_resource_role.granted',
        resourceType: 'GroupResourceRole',
        resourceId: role.id,
        after: { groupId, role: 'FLOOR_MANAGER', scopeType: 'FLOOR', floorId: id },
        ipAddress: request.ip,
      }, request.log)

      return reply.status(201).send({ data: { roleId: role.id, id: group.id, name: group.name } })
    },
  )

  // DELETE /floors/:id/group-managers/:groupId — remove a group floor manager (SUPER_ADMIN or building admin)
  fastify.delete(
    '/:id/group-managers/:groupId',
    { preHandler: [requireAuth] },
    async (request, reply) => {
      const { id, groupId } = request.params as { id: string; groupId: string }
      if (request.user.globalRole !== GlobalRole.SUPER_ADMIN) {
        const floor = await prisma.floor.findUnique({ where: { id }, select: { buildingId: true } })
        if (!floor) return reply.status(404).send({ error: { message: 'Floor not found', code: 'NOT_FOUND' } })
        const canManage = await isBuildingManagerForBuilding(request.user.id, floor.buildingId)
        if (!canManage) return reply.status(403).send({ error: { message: 'Insufficient permissions', code: 'FORBIDDEN' } })
      }

      const role = await prisma.groupResourceRole.findFirst({
        where: { groupId, scopeType: 'FLOOR', floorId: id },
      })
      if (!role) {
        return reply.status(404).send({ error: { message: 'Group role not found', code: 'NOT_FOUND' } })
      }

      // deleteMany on the full scope filter, not delete-by-id — see the
      // matching comment in buildings.ts's DELETE /group-managers/:groupId.
      await prisma.groupResourceRole.deleteMany({ where: { groupId, scopeType: 'FLOOR', floorId: id } })
      await recordAuditLog(prisma, {
        actorId: request.user.id,
        action: 'group_resource_role.revoked',
        resourceType: 'GroupResourceRole',
        resourceId: role.id,
        before: { groupId, role: 'FLOOR_MANAGER', scopeType: 'FLOOR', floorId: id },
        ipAddress: request.ip,
      }, request.log)
      return reply.status(200).send({ data: { ok: true } })
    },
  )

  // POST /floors — create floor
  fastify.post(
    '/',
    { preHandler: [requireAuth] },
    async (request, reply) => {
      const result = createFloorSchema.safeParse(request.body)
      if (!result.success) {
        return reply.status(400).send({
          error: { message: 'Validation failed', code: 'VALIDATION_ERROR', details: result.error.flatten() },
        })
      }

      if (request.user.globalRole !== GlobalRole.SUPER_ADMIN) {
        const canManage = await isBuildingManagerForBuilding(request.user.id, result.data.buildingId)
        if (!canManage) return reply.status(403).send({ error: { message: 'Insufficient permissions', code: 'FORBIDDEN' } })
      }

      const building = await prisma.building.findUnique({ where: { id: result.data.buildingId } })
      if (!building) {
        return reply.status(404).send({ error: { message: 'Building not found', code: 'NOT_FOUND' } })
      }

      const floor = await prisma.floor.create({
        data: {
          buildingId: result.data.buildingId,
          name: result.data.name,
          level: result.data.level ?? 0,
        },
      })
      await recordAuditLog(prisma, {
        actorId: request.user.id,
        action: 'floor.created',
        resourceType: 'Floor',
        resourceId: floor.id,
        after: { buildingId: floor.buildingId, name: floor.name, level: floor.level },
        ipAddress: request.ip,
      }, request.log)

      return reply.status(201).send({ data: floor })
    },
  )

  // PUT /floors/:id — update floor (SUPER_ADMIN or floor manager for that floor)
  fastify.put(
    '/:id',
    { preHandler: [requireAuth] },
    async (request, reply) => {
      const { id } = request.params as { id: string }

      if (request.user.globalRole !== GlobalRole.SUPER_ADMIN) {
        const canManage = await isFloorManagerForFloor(request.user.id, id)
        if (!canManage) {
          return reply.status(403).send({ error: { message: 'Insufficient permissions', code: 'FORBIDDEN' } })
        }
      }

      const result = updateFloorSchema.safeParse(request.body)
      if (!result.success) {
        return reply.status(400).send({
          error: { message: 'Validation failed', code: 'VALIDATION_ERROR', details: result.error.flatten() },
        })
      }

      try {
        const before = await prisma.floor.findUnique({ where: { id }, select: { name: true, level: true } })
        const floor = await prisma.floor.update({ where: { id }, data: result.data })
        await recordAuditLog(prisma, {
          actorId: request.user.id,
          action: 'floor.updated',
          resourceType: 'Floor',
          resourceId: id,
          before,
          after: { name: floor.name, level: floor.level },
          ipAddress: request.ip,
        }, request.log)
        return reply.status(200).send({ data: floor })
      } catch {
        return reply.status(404).send({ error: { message: 'Floor not found', code: 'NOT_FOUND' } })
      }
    },
  )

  // DELETE /floors/:id (SUPER_ADMIN or building admin)
  fastify.delete(
    '/:id',
    { preHandler: [requireAuth] },
    async (request, reply) => {
      const { id } = request.params as { id: string }

      if (request.user.globalRole !== GlobalRole.SUPER_ADMIN) {
        const floor = await prisma.floor.findUnique({ where: { id }, select: { buildingId: true } })
        if (!floor) {
          return reply.status(404).send({ error: { message: 'Floor not found', code: 'NOT_FOUND' } })
        }
        const ok = await isBuildingManagerForBuilding(request.user.id, floor.buildingId)
        if (!ok) {
          return reply.status(403).send({ error: { message: 'Insufficient permissions', code: 'FORBIDDEN' } })
        }
      }

      // Must run before the delete: once the floor is gone, Asset.floorId is
      // SetNull and there's no longer any way to find which bookings were on it.
      await cancelFutureBookingsForFloors([id])
      // Same policy for queue entries — a WAITING/PROMOTED entry on a desk
      // about to become unplaced (and unreachable from any floor plan) is
      // released the same way its bookings are, not left dangling.
      await cancelQueueEntriesForFloors([id])

      // The pre-delete asset/floor-plan snapshot and the delete itself run
      // inside one transaction, locking the floor row first — same race and
      // same fix shape as zones.ts DELETE /:id: a concurrent PATCH /assets/:id
      // that places an asset onto this floor needs an FK check against this
      // row, so Postgres blocks it until we commit, then it fails outright
      // (the floor being gone) instead of racing our snapshot below.
      //
      // floorPlan is read here too, not before the transaction — the upload
      // path (POST /:id/floor-plan) takes the exact same FOR UPDATE lock
      // before its own upsert, so a floorPlan snapshot taken before this
      // transaction acquires the lock can miss a floor plan an upload
      // committed in the gap: the delete's cascade would then remove that
      // FloorPlan row with no matching entry in this function's cleanup
      // list, permanently orphaning its files on disk. Reading it after the
      // lock is acquired means it always reflects whatever the upload path
      // last committed.
      const { result, floorPlan } = await prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM "Floor" WHERE id = ${id} FOR UPDATE`
        const before = await tx.floor.findUnique({ where: { id }, select: { buildingId: true, name: true, level: true } })
        if (!before) return { result: null, floorPlan: null }
        const floorAssetIds = (await tx.asset.findMany({ where: { floorId: id }, select: { id: true } })).map((a) => a.id)
        const floorPlan = await tx.floorPlan.findUnique({ where: { floorId: id } })
        await tx.floor.delete({ where: { id } })
        if (floorAssetIds.length > 0) {
          // Asset.floorId/primaryZoneId SetNull automatically via cascade,
          // but stale x/y/width/height/rotation survive — same "vanishes into
          // a gap no admin screen can reach" issue as deleting a zone (#206),
          // just missing here for the floor-delete path until now. Left
          // uncleared, a later re-placement on a different floor without
          // explicit repositioning renders at this stale, nonsensical spot.
          await tx.asset.updateMany({
            where: { id: { in: floorAssetIds } },
            data: { x: null, y: null, width: null, height: null, rotation: null },
          })
        }
        return { result: before, floorPlan }
      }).catch(() => ({ result: null, floorPlan: null }))

      if (!result) {
        return reply.status(404).send({ error: { message: 'Floor not found', code: 'NOT_FOUND' } })
      }
      await recordAuditLog(prisma, {
        actorId: request.user.id,
        action: 'floor.deleted',
        resourceType: 'Floor',
        resourceId: id,
        before: result,
        ipAddress: request.ip,
      }, request.log)

      if (floorPlan) {
        await deleteFile(floorPlan.originalPath)
        if (floorPlan.renderedPath !== floorPlan.originalPath) {
          await deleteFile(floorPlan.renderedPath)
        }
        if (floorPlan.thumbnailPath) {
          await deleteFile(floorPlan.thumbnailPath)
        }
      }

      return reply.status(200).send({ data: { ok: true } })
    },
  )

  // POST /floors/:id/floor-plan — upload floor plan (SUPER_ADMIN or floor manager for that floor)
  fastify.post(
    '/:id/floor-plan',
    { preHandler: [requireAuth], config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const { id } = request.params as { id: string }

      if (request.user.globalRole !== GlobalRole.SUPER_ADMIN) {
        const canManage = await isFloorManagerForFloor(request.user.id, id)
        if (!canManage) {
          return reply.status(403).send({ error: { message: 'Insufficient permissions', code: 'FORBIDDEN' } })
        }
      }

      const floor = await prisma.floor.findUnique({ where: { id } })
      if (!floor) {
        return reply.status(404).send({ error: { message: 'Floor not found', code: 'NOT_FOUND' } })
      }

      const data = await request.file()
      if (!data) {
        return reply.status(400).send({ error: { message: 'No file uploaded', code: 'NO_FILE' } })
      }

      // Validate MIME type. DXF has no browser-standard MIME type, so real
      // uploads legitimately arrive as 'application/octet-stream' (the
      // common fallback for unrecognised extensions) or 'text/plain' (DXF is
      // plaintext) rather than a DXF-specific value — both already covered
      // below. This used to also unconditionally accept ANY declared
      // mimetype whenever the filename ended in '.dxf', which let a request
      // skip MIME validation entirely just by naming the upload right
      // (content-type is never trusted for serving it back — floor-plan
      // image serving derives Content-Type from the file extension, not
      // this stored value — but it's still a real validation gap the
      // allowlist exists to close).
      const allowedMimes = [
        'image/png', 'image/jpeg', 'image/webp', 'image/gif',
        'application/pdf',
        'image/vnd.dxf', 'application/dxf', 'application/octet-stream', 'text/plain',
      ]
      if (!allowedMimes.includes(data.mimetype)) {
        return reply.status(400).send({
          error: { message: 'Unsupported file type', code: 'INVALID_FILE_TYPE' },
        })
      }

      // Validate and save the new file BEFORE touching the old one — this can
      // still reject on invalid magic bytes, and if the old files were already
      // deleted at that point, a rejected replacement would leave a floor with
      // no working plan at all instead of just failing the upload.
      let saved: Awaited<ReturnType<typeof saveFloorPlan>>
      try {
        saved = await saveFloorPlan(data)
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'INVALID_MAGIC') {
          return reply.status(400).send({ error: { message: 'File content does not match the declared MIME type', code: 'INVALID_FILE_TYPE' } })
        }
        throw err
      }

      // Re-read "existing" and upsert inside one transaction, locking the
      // floor row first — two concurrent uploads to the same floor each
      // computed their own stale `existing` snapshot before saveFloorPlan
      // (slow: image/PDF/DXF processing), so whichever upsert lost pointed at
      // a file its own `existing` never captured, permanently orphaning it on
      // disk. Locking here serializes the read+upsert step: the loser now
      // re-reads the winner's just-committed row as `existing` and correctly
      // schedules those files for deletion instead of its own already-stale
      // ones. File I/O stays outside the transaction/lock.
      const { floorPlan, existing } = await prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM "Floor" WHERE id = ${id} FOR UPDATE`
        const existing = await tx.floorPlan.findUnique({ where: { floorId: id } })
        const floorPlan = await tx.floorPlan.upsert({
          where: { floorId: id },
          update: {
            fileType: saved.fileType,
            originalPath: saved.originalPath,
            renderedPath: saved.renderedPath,
            thumbnailPath: saved.thumbnailPath,
            width: saved.width,
            height: saved.height,
          },
          create: {
            floorId: id,
            fileType: saved.fileType,
            originalPath: saved.originalPath,
            renderedPath: saved.renderedPath,
            thumbnailPath: saved.thumbnailPath,
            width: saved.width,
            height: saved.height,
          },
        })
        return { floorPlan, existing }
      })

      if (existing) {
        await deleteFile(existing.originalPath)
        if (existing.renderedPath !== existing.originalPath) {
          await deleteFile(existing.renderedPath)
        }
        if (existing.thumbnailPath) {
          await deleteFile(existing.thumbnailPath)
        }
      }

      await recordAuditLog(prisma, {
        actorId: request.user.id,
        action: existing ? 'floor_plan.replaced' : 'floor_plan.uploaded',
        resourceType: 'FloorPlan',
        resourceId: floorPlan.id,
        before: existing ? { fileType: existing.fileType, width: existing.width, height: existing.height } : null,
        after: { fileType: floorPlan.fileType, width: floorPlan.width, height: floorPlan.height },
        ipAddress: request.ip,
      }, request.log)

      return reply.status(200).send({ data: floorPlan })
    },
  )

  // GET /floors/:id/floor-plan/image — stream rendered floor plan
  fastify.get('/:id/floor-plan/image', { preHandler: [requireAuth], config: { rateLimit: { max: 120, timeWindow: '1 minute' } } }, async (request, reply) => {
    const { id } = request.params as { id: string }

    const floorPlan = await prisma.floorPlan.findUnique({
      where: { floorId: id },
      include: { floor: { select: { buildingId: true } } },
    })
    if (!floorPlan) {
      return reply.status(404).send({ error: { message: 'Floor plan not found', code: 'NOT_FOUND' } })
    }

    if (request.user.globalRole !== GlobalRole.SUPER_ADMIN) {
      const hasAccess = await checkGroupAccess(request.user.id, floorPlan.floor.buildingId, id)
      if (!hasAccess) {
        return reply.status(403).send({ error: { message: 'You do not have access to this floor', code: 'FORBIDDEN' } })
      }
    }

    const absPath = resolveStoragePath(floorPlan.renderedPath)

    try {
      await fs.promises.access(absPath, fs.constants.R_OK)
    } catch {
      return reply.status(404).send({ error: { message: 'Floor plan file not found', code: 'FILE_NOT_FOUND' } })
    }

    const ext = path.extname(floorPlan.renderedPath).toLowerCase()
    const mimeMap: Record<string, string> = {
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.webp': 'image/webp',
      '.pdf': 'application/pdf',
      '.svg': 'image/svg+xml',
    }
    const contentType = mimeMap[ext] ?? 'application/octet-stream'

    // Optional stroke colour override for SVG floor plans (DXF-derived).
    // Accepts a plain 6-character hex string without the # prefix (e.g. stroke=e2e8f0).
    const { stroke: rawStroke } = request.query as { stroke?: string }
    let stroke: string | undefined
    if (rawStroke !== undefined && rawStroke !== '') {
      if (!/^[0-9a-fA-F]{6}$/.test(rawStroke)) {
        return reply.status(400).send({ error: { message: 'Invalid stroke colour — provide a 6-character hex string without # (e.g. e2e8f0)', code: 'INVALID_PARAM' } })
      }
      stroke = `#${rawStroke}`
    }

    if (contentType === 'image/svg+xml' && stroke) {
      const raw = await fs.promises.readFile(absPath, 'utf-8')
      const recolored = raw.replace(/stroke="[^"]*"/g, `stroke="${stroke}"`)
      reply
        .header('Content-Type', contentType)
        .header('Cache-Control', 'public, max-age=86400')
        .header('Content-Security-Policy', "default-src 'none'")
        .header('X-Content-Type-Options', 'nosniff')
      return reply.send(recolored)
    }

    const stream = fs.createReadStream(absPath)
    reply.header('Content-Type', contentType)
    reply.header('Cache-Control', 'public, max-age=86400')
    // SVG files support embedded scripts; lock them down to prevent stored XSS
    if (contentType === 'image/svg+xml') {
      reply.header('Content-Security-Policy', "default-src 'none'")
      reply.header('X-Content-Type-Options', 'nosniff')
    }
    return reply.send(stream)
  })

  // PATCH /floors/:id/floor-plan/transform — update display scale (SUPER_ADMIN or floor manager)
  fastify.patch(
    '/:id/floor-plan/transform',
    {
      preHandler: [
        requireAuth,
        async (request, reply) => {
          const { id } = request.params as { id: string }
          if (request.user.globalRole === GlobalRole.SUPER_ADMIN) return
          const isManager = await isFloorManagerForFloor(request.user.id, id)
          if (!isManager) {
            return reply.status(403).send({ error: { message: 'Insufficient permissions', code: 'FORBIDDEN' } })
          }
        },
      ],
    },
    async (request, reply) => {
      const { id } = request.params as { id: string }
      const { displayScale } = request.body as { displayScale: unknown }

      if (typeof displayScale !== 'number' || displayScale < 0.1 || displayScale > 10) {
        return reply.status(400).send({ error: { message: 'displayScale must be a number between 0.1 and 10', code: 'VALIDATION_ERROR' } })
      }

      const floorPlan = await prisma.floorPlan.findUnique({ where: { floorId: id } })
      if (!floorPlan) {
        return reply.status(404).send({ error: { message: 'No floor plan uploaded for this floor', code: 'NOT_FOUND' } })
      }

      const updated = await prisma.floorPlan.update({
        where: { floorId: id },
        data: { displayScale },
      })
      await recordAuditLog(prisma, {
        actorId: request.user.id,
        action: 'floor_plan.transform_updated',
        resourceType: 'FloorPlan',
        resourceId: updated.id,
        before: { displayScale: floorPlan.displayScale },
        after: { displayScale: updated.displayScale },
        ipAddress: request.ip,
      }, request.log)

      return reply.send({ data: updated })
    },
  )

  // GET /floors/:id/availability?date=YYYY-MM-DD
  // Returns zones with nested bookable assets and computed bookingStatus for the requesting user.
  fastify.get('/:id/availability', { preHandler: [requireAuth] }, async (request, reply) => {
    const { id } = request.params as { id: string }
    const queryResult = z.object({
      date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      // Optional comma-separated amenity filter, e.g. ?amenities=monitor,standing.
      // Returns only assets that have ALL listed amenities.
      amenities: z.string().optional(),
    }).safeParse(request.query)
    if (!queryResult.success || !queryResult.data.date) {
      return reply.status(400).send({
        error: { message: 'date query param required (YYYY-MM-DD)', code: 'INVALID_DATE' },
      })
    }
    const { date } = queryResult.data
    const amenityFilter = queryResult.data.amenities
      ? queryResult.data.amenities.split(',').map((s) => s.trim()).filter(Boolean)
      : []
    // Matched case-insensitively below (not via Prisma's hasEvery, which is
    // exact-string) — amenities are free text entered independently via the
    // asset form, CSV import, and manual edits, with nothing normalising
    // casing between them. Without this, "Standing Desk" and "standing desk"
    // silently never matched each other's assets, splitting one amenity into
    // two dead-looking filter options.
    const amenityFilterLower = amenityFilter.map((a) => a.toLowerCase())

    const currentUserId = request.user.id

    // Resolve the floor's building timezone BEFORE building the day window
    // used below — every asset on a floor shares one building (see #72), so
    // (unlike directory.ts's multi-building /whereabouts, which needs a
    // widen-then-precise-filter two-pass approach) this can compute the
    // exact local-day boundary upfront rather than a fixed UTC window. A
    // fixed `${date}T00:00:00.000Z`..`23:59:59.999Z` window is only correct
    // for a UTC building — for e.g. a Pacific/Honolulu (UTC-10) building, a
    // booking made for the evening of the 15th local time lands at
    // 2026-01-16T02:00–03:30Z, which a UTC-anchored window for "the 15th"
    // misses entirely (it falls outside dayEnd), showing the desk as
    // available when it's actually booked that evening — and misattributes
    // it to the 16th instead when that day is queried.
    const [floorForTz, orgForTz] = await Promise.all([
      prisma.floor.findUnique({ where: { id }, select: { building: { select: { timezone: true } } } }),
      prisma.organisation.findFirst({ select: { defaultTimezone: true } }),
    ])
    if (!floorForTz) {
      return reply.status(404).send({ error: { message: 'Floor not found', code: 'NOT_FOUND' } })
    }
    const [year, month, day] = date.split('-').map(Number)
    const availabilityTimezone = floorForTz.building?.timezone ?? orgForTz?.defaultTimezone ?? 'UTC'
    const dayStart = zonedWallClockToUtc(year, month, day, 0, 0, availabilityTimezone)
    const dayEnd = new Date(dayStart.getTime() + 24 * 60 * 60 * 1000 - 1)
    // The requested date's own weekday, independent of dayStart — for a
    // building ahead of UTC (e.g. Australia/Sydney, +10), local midnight of
    // the requested day is the *previous* UTC calendar day, so
    // dayStart.getUTCDay() would silently return the wrong weekday for any
    // such building. Computed via Date.UTC on the plain Y/M/D triplet, which
    // has no timezone ambiguity at all.
    const requestedWeekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay()

    // Shared per-asset include shape — reused for both primary-zone assets
    // (zone.assets) and secondary-zone memberships (zone.assetZones.asset) so
    // a shared asset carries the exact same booking/queue/availability data
    // regardless of which zone's list it's read from.
    const assetInclude = {
      category: { select: { id: true, name: true, defaultIcon: true, colour: true, iconUrl: true } },
      allowList: { select: { userId: true } },
      userAssignments: {
        select: {
          isPrimary: true,
          user: { select: { id: true, displayName: true, email: true } },
        },
      },
      bookings: {
        where: {
          // PENDING_APPROVAL reserves the slot exactly like CONFIRMED (#74),
          // so it must show as occupied here too — otherwise the floor plan
          // shows a slot as available when booking it would immediately hit
          // the booking_no_overlap exclusion constraint / hasBlockingOverlap.
          status: { in: ['CONFIRMED', 'PENDING_APPROVAL'] },
          startsAt: { lt: dayEnd },
          endsAt: { gt: dayStart },
        },
        select: {
          id: true,
          userId: true,
          startsAt: true,
          endsAt: true,
          attendeeCount: true,
          status: true,
          user: { select: { displayName: true } },
        },
      },
      queueEntries: {
        where: {
          userId: currentUserId,
          status: { in: ['WAITING', 'PROMOTED'] as const },
          wantedStartsAt: { lt: dayEnd },
          wantedEndsAt: { gt: dayStart },
        },
        select: { id: true, status: true, position: true, claimDeadline: true, expiresAt: true, wantedStartsAt: true, wantedEndsAt: true },
      },
      availabilityWindows: {
        where: {
          startsAt: { lte: dayEnd },
          endsAt: { gte: dayStart },
        },
        select: { id: true, startsAt: true, endsAt: true, ownerId: true },
      },
      availabilityRules: { select: { weekday: true } },
    } satisfies Prisma.AssetInclude

    const [floor, org] = await Promise.all([
      prisma.floor.findUnique({
        where: { id },
        include: {
          building: { select: { requiresApproval: true, timezone: true } },
          zones: {
            orderBy: { name: 'asc' },
            include: {
              assets: {
                where: { isBookable: true },
                orderBy: { name: 'asc' },
                include: assetInclude,
              },
              assetZones: {
                where: { asset: { isBookable: true } },
                include: { asset: { include: assetInclude } },
              },
            },
          },
        },
      }),
      prisma.organisation.findFirst({ select: { requiresApproval: true, defaultTimezone: true } }),
    ])

    if (!floor) {
      return reply.status(404).send({ error: { message: 'Floor not found', code: 'NOT_FOUND' } })
    }

    // Resolved once for the whole floor (every asset on it shares the same
    // building — see #72), not per-asset: the frontend uses this to render
    // every booking time on this floor's plan in the building's own
    // timezone rather than the viewer's browser timezone. Reuses
    // availabilityTimezone (computed above from the same building/org
    // values, just fetched slightly earlier) rather than recomputing it, so
    // the day window actually used in the queries above and the timezone
    // reported to the client can never disagree.
    const resolvedTimezone = availabilityTimezone

    // Fold secondary (AssetZone) memberships into each zone's asset list —
    // done once here so every computation below (amenity filter, queue-depth
    // lookup, zone-group booked-set, the final per-zone response) already
    // sees the full membership without needing its own merge step.
    const mergedZones = floor.zones.map((zone) => ({
      ...zone,
      assets: mergeZoneAssets(zone.assets, zone.assetZones),
    }))

    if (amenityFilterLower.length) {
      for (const zone of mergedZones) {
        zone.assets = zone.assets.filter((a) => {
          const assetAmenitiesLower = a.amenities.map((am) => am.toLowerCase())
          return amenityFilterLower.every((wanted) => assetAmenitiesLower.includes(wanted))
        })
      }
    }

    if (request.user.globalRole !== GlobalRole.SUPER_ADMIN) {
      const hasAccess = await checkGroupAccess(request.user.id, floor.buildingId, id)
      if (!hasAccess) {
        return reply.status(403).send({ error: { message: 'You do not have access to this floor', code: 'FORBIDDEN' } })
      }
    }

    type AvailabilityStatus = 'available' | 'mine' | 'mine_pending' | 'booked' | 'restricted' | 'assigned' | 'disabled' | 'queued' | 'promoted' | 'zone_conflict'

    // Build a map of assetId → count of WAITING queue entries for the requested period
    const allAssetIds = mergedZones.flatMap((z) => z.assets.map((a) => a.id))
    const queueDepthRows = await prisma.queueEntry.groupBy({
      by: ['assetId'],
      where: {
        assetId: { in: allAssetIds },
        status: 'WAITING',
        wantedStartsAt: { lt: dayEnd },
        wantedEndsAt: { gt: dayStart },
      },
      _count: { assetId: true },
    })
    const queueDepthByAsset = new Map(queueDepthRows.map((r) => [r.assetId, r._count.assetId]))

    // Collect zone group IDs where the current user has a booking today
    const userBookedZoneGroupIds = new Set<string>()
    for (const zone of mergedZones) {
      if (!zone.zoneGroupId) continue
      for (const asset of zone.assets) {
        if (asset.bookings.some((b) => b.userId === currentUserId)) {
          userBookedZoneGroupIds.add(zone.zoneGroupId)
        }
      }
    }

    const zones = mergedZones.map((zone) => {
      const assets = zone.assets.map((asset) => {
        const myBooking = asset.bookings.find((b) => b.userId === currentUserId)
        const othersBookings = asset.bookings.filter((b) => b.userId !== currentUserId)
        const myQueueEntry = asset.queueEntries[0] ?? null
        const isOnAllowList = asset.allowList.some((a) => a.userId === currentUserId)
        const isAssignedUser = asset.userAssignments.some((ua) => ua.user.id === currentUserId)
        const hasAvailabilityWindow = (asset.availabilityWindows ?? []).length > 0
        // Mirrors assertBookable's isCoveredByAvailabilityRules (lib/booking.ts):
        // a non-assigned user may book an ASSIGNED desk on a weekday its owner
        // has marked recurringly available, not just via a one-off window. The
        // floor plan must reflect that or it shows "assigned"/unbookable for a
        // desk the booking endpoint would actually accept.
        const hasAvailabilityRule = (asset.availabilityRules ?? []).some((r) => r.weekday === requestedWeekday)

        let bookingStatus: AvailabilityStatus

        if (asset.bookingStatus === 'DISABLED') {
          bookingStatus = 'disabled'
        } else if (myBooking) {
          bookingStatus = myBooking.status === 'PENDING_APPROVAL' ? 'mine_pending' : 'mine'
        } else if (othersBookings.length > 0) {
          if (myQueueEntry?.status === 'PROMOTED') {
            bookingStatus = 'promoted'
          } else if (myQueueEntry?.status === 'WAITING') {
            bookingStatus = 'queued'
          } else {
            bookingStatus = 'booked'
          }
        } else if (
          (asset.bookingStatus === 'ASSIGNED' || asset.userAssignments.length > 0) &&
          !isAssignedUser &&
          !hasAvailabilityWindow &&
          !hasAvailabilityRule
        ) {
          // Non-assigned user: reflect their queue state for this assigned desk
          if (myQueueEntry?.status === 'PROMOTED') {
            bookingStatus = 'promoted'
          } else if (myQueueEntry?.status === 'WAITING') {
            bookingStatus = 'queued'
          } else {
            bookingStatus = 'assigned'
          }
        } else if (
          asset.bookingStatus === 'RESTRICTED' &&
          !isOnAllowList &&
          !isAssignedUser
        ) {
          bookingStatus = 'restricted'
        } else {
          bookingStatus = 'available'
        }

        // Zone group conflict: asset is available but user already has a booking in the same zone group
        if (
          bookingStatus === 'available' &&
          zone.zoneGroupId &&
          userBookedZoneGroupIds.has(zone.zoneGroupId)
        ) {
          bookingStatus = 'zone_conflict'
        }

        return {
          id: asset.id,
          zoneId: zone.id,
          zoneName: zone.name,
          zoneColour: zone.colour,
          // A shared asset (AssetZone secondary membership) appears once per
          // zone it belongs to in this nested response — isPrimaryZone lets
          // the frontend's flattened canvas view keep only one marker per
          // asset (at its actual x/y) while still surfacing it under every
          // zone it belongs to for any zone-scoped list/filter.
          isPrimaryZone: asset.isPrimaryZone,
          name: asset.name,
          bookingLabel: asset.bookingLabel,
          isBookable: asset.isBookable,
          category: asset.category
            ? {
                ...asset.category,
                iconUrl: asset.category.iconUrl
                  ? `/api/v1/assets/categories/${asset.category.id}/icon`
                  : null,
              }
            : null,
          x: asset.x,
          y: asset.y,
          width: asset.width,
          height: asset.height,
          rotation: asset.rotation,
          capacity: asset.capacity,
          bookingStatus: bookingStatus,
          rawBookingStatus: asset.bookingStatus,
          amenities: asset.amenities,
          availabilityStatus: bookingStatus,
          // Zone → building → org override chain (#74) — lets the booking
          // form warn "this needs approval" before the user submits, rather
          // than only finding out from the PENDING_APPROVAL response after.
          requiresApproval: zone.requiresApproval ?? floor.building?.requiresApproval ?? org?.requiresApproval ?? false,
          currentBooking: myBooking
            ? { id: myBooking.id, userId: myBooking.userId, startsAt: myBooking.startsAt, endsAt: myBooking.endsAt, attendeeCount: myBooking.attendeeCount, status: myBooking.status }
            : othersBookings[0]
            ? { id: othersBookings[0].id, userId: othersBookings[0].userId, startsAt: othersBookings[0].startsAt, endsAt: othersBookings[0].endsAt, attendeeCount: othersBookings[0].attendeeCount, bookerName: othersBookings[0].user?.displayName }
            : null,
          bookedBy: othersBookings.map((b) => ({ userId: b.userId, displayName: b.user?.displayName ?? 'Unknown' })),
          myQueueEntry,
          queueDepth: queueDepthByAsset.get(asset.id) ?? 0,
          assignedUsers: asset.userAssignments.map((ua) => ({ ...ua.user, isPrimary: ua.isPrimary })),
        }
      })

      return {
        id: zone.id,
        name: zone.name,
        colour: zone.colour,
        assets,
      }
    })

    return reply.status(200).send({ data: { floorId: floor.id, date, zones, resolvedTimezone } })
  })
}

// Re-export resolveStoragePath for use by other routes if needed
export { resolveStoragePath }
