import type { FastifyInstance } from 'fastify'
import { prisma } from '../lib/prisma.js'
import { createBuildingSchema, updateBuildingSchema, GlobalRole } from '@roomer/shared'
import { requireAuth } from '../middleware/requireAuth.js'
import { requireGlobalRole, getManagedBuildingIds } from '../middleware/requireRole.js'
import { canUserAccessBuilding } from './groups.js'
import { cancelFutureBookingsForFloors } from '../lib/queue.js'
import { deleteFile } from '../lib/storage.js'

/**
 * Filter a building's floors down to the ones `userId` may access, matching
 * canUserAccessFloor's "restricted only if a GroupFloorAccess rule exists"
 * semantics but batched into 2 queries regardless of floor count (rather
 * than one canUserAccessFloor call per floor).
 */
async function filterAccessibleFloors<T extends { id: string }>(userId: string, floors: T[]): Promise<T[]> {
  if (floors.length === 0) return floors
  const floorIds = floors.map((f) => f.id)
  const [restricted, memberships] = await Promise.all([
    prisma.groupFloorAccess.findMany({ where: { floorId: { in: floorIds } }, select: { floorId: true, groupId: true } }),
    prisma.userGroupMember.findMany({ where: { userId }, select: { groupId: true } }),
  ])
  const userGroupIds = new Set(memberships.map((m) => m.groupId))
  const restrictedBy = new Map<string, Set<string>>()
  for (const r of restricted) {
    let set = restrictedBy.get(r.floorId)
    if (!set) { set = new Set(); restrictedBy.set(r.floorId, set) }
    set.add(r.groupId)
  }
  return floors.filter((f) => {
    const groups = restrictedBy.get(f.id)
    if (!groups || groups.size === 0) return true // open floor
    for (const g of userGroupIds) if (groups.has(g)) return true
    return false
  })
}
import { z } from 'zod'
export async function buildingRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.addHook('onRoute', (route) => { route.schema = { tags: ['Buildings'], ...route.schema } })

  // GET /buildings/:id/access-summary — "who can access / manage this building?"
  fastify.get('/:id/access-summary', { preHandler: [requireAuth, requireGlobalRole(GlobalRole.SUPER_ADMIN)] }, async (request, reply) => {
    const { id } = request.params as { id: string }
    const building = await prisma.building.findUnique({ where: { id }, select: { id: true, name: true } })
    if (!building) return reply.status(404).send({ error: { message: 'Building not found', code: 'NOT_FOUND' } })

    const [accessGroups, directManagers, groupManagers] = await Promise.all([
      prisma.groupBuildingAccess.findMany({ where: { buildingId: id }, select: { group: { select: { id: true, name: true } } } }),
      prisma.userResourceRole.findMany({
        where: { scopeType: 'BUILDING', buildingId: id, role: 'BUILDING_ADMIN' },
        select: { source: true, user: { select: { id: true, displayName: true, email: true } } },
      }),
      prisma.groupResourceRole.findMany({
        where: { scopeType: 'BUILDING', buildingId: id, role: 'BUILDING_ADMIN' },
        select: { source: true, group: { select: { id: true, name: true, _count: { select: { members: true } } } } },
      }),
    ])

    return reply.status(200).send({
      data: {
        buildingId: building.id,
        name: building.name,
        access: {
          restricted: accessGroups.length > 0,
          groups: accessGroups.map((a) => a.group),
        },
        managers: {
          direct: directManagers.map((m) => ({ ...m.user, source: m.source })),
          viaGroups: groupManagers.map((m) => ({ ...m.group, memberCount: m.group._count.members, source: m.source })),
        },
      },
    })
  })

  // GET /buildings — list buildings the requesting user can access
  // SUPER_ADMINs see every building. Regular users only see buildings that are
  // either unrestricted (no GroupBuildingAccess rows) or have a matching group.
  fastify.get('/', { preHandler: [requireAuth] }, async (request, reply) => {
    const isAdmin = request.user.globalRole === GlobalRole.SUPER_ADMIN

    if (isAdmin) {
      const buildings = await prisma.building.findMany({
        include: {
          organisation: { select: { id: true, name: true, slug: true } },
          _count: { select: { floors: true } },
        },
        orderBy: { name: 'asc' },
      })
      return reply.status(200).send({ data: buildings })
    }

    // For regular users: return open buildings, group-accessible buildings,
    // and any buildings where this user is a building admin. Building-admin
    // status must come from getManagedBuildingIds (direct UserResourceRole OR
    // GroupResourceRole) — a plain UserResourceRole-only query here missed
    // anyone who's only a building admin via a group, so they could never
    // select their own building on pages that source options from this list
    // (e.g. creating a lease), even though the backend would authorize the
    // request once made.
    const [userGroupIds, adminBuildingIds] = await Promise.all([
      prisma.userGroupMember.findMany({
        where: { userId: request.user.id },
        select: { groupId: true },
      }).then((rows) => rows.map((m) => m.groupId)),
      getManagedBuildingIds(request.user.id),
    ])

    const buildings = await prisma.building.findMany({
      where: {
        OR: [
          { groupAccess: { none: {} } },                                    // open
          { groupAccess: { some: { groupId: { in: userGroupIds } } } },     // user's group has access
          ...(adminBuildingIds.length > 0 ? [{ id: { in: adminBuildingIds } }] : []),  // user is building admin
        ],
      },
      include: {
        organisation: { select: { id: true, name: true, slug: true } },
        _count: { select: { floors: true } },
      },
      orderBy: { name: 'asc' },
    })

    return reply.status(200).send({ data: buildings })
  })

  // POST /buildings — create building (SUPER_ADMIN only)
  fastify.post(
    '/',
    { preHandler: [requireAuth, requireGlobalRole(GlobalRole.SUPER_ADMIN)] },
    async (request, reply) => {
      const result = createBuildingSchema.safeParse(request.body)
      if (!result.success) {
        return reply.status(400).send({
          error: { message: 'Validation failed', code: 'VALIDATION_ERROR', details: result.error.flatten() },
        })
      }

      // Use the first organisation (single-tenant v1)
      const org = await prisma.organisation.findFirst()
      if (!org) {
        return reply.status(500).send({
          error: { message: 'No organisation found', code: 'NO_ORGANISATION' },
        })
      }

      const building = await prisma.building.create({
        data: {
          organisationId: org.id,
          name: result.data.name,
          address: result.data.address ?? null,
        },
        include: { _count: { select: { floors: true } } },
      })

      return reply.status(201).send({ data: building })
    },
  )

  // GET /buildings/:id — get building with floors (access-gated)
  fastify.get('/:id', { preHandler: [requireAuth] }, async (request, reply) => {
    const { id } = request.params as { id: string }

    const isAdmin = request.user.globalRole === GlobalRole.SUPER_ADMIN

    // Check building-level access for non-admins
    if (!isAdmin) {
      const hasAccess = await canUserAccessBuilding(request.user.id, id)
      if (!hasAccess) {
        return reply.status(404).send({ error: { message: 'Building not found', code: 'NOT_FOUND' } })
      }
    }

    const building = await prisma.building.findUnique({
      where: { id },
      include: {
        organisation: { select: { id: true, name: true, slug: true } },
        floors: {
          orderBy: { level: 'asc' },
          include: {
            _count: { select: { zones: true } },
          },
        },
        _count: { select: { floors: true } },
      },
    })

    if (!building) {
      return reply.status(404).send({
        error: { message: 'Building not found', code: 'NOT_FOUND' },
      })
    }

    // Individual floors can carry their own GroupFloorAccess restriction even
    // when the building itself is open — don't leak the existence/name of a
    // floor-restricted floor to a user who only cleared the building check.
    if (!isAdmin) {
      building.floors = await filterAccessibleFloors(request.user.id, building.floors)
      building._count.floors = building.floors.length
    }

    return reply.status(200).send({ data: building })
  })

  // ─── Building access group management (SUPER_ADMIN) ───────────────────────

  // GET /buildings/:id/access-groups — list groups with access to this building
  fastify.get(
    '/:id/access-groups',
    { preHandler: [requireAuth, requireGlobalRole(GlobalRole.SUPER_ADMIN)] },
    async (request, reply) => {
      const { id } = request.params as { id: string }

      const building = await prisma.building.findUnique({ where: { id } })
      if (!building) {
        return reply.status(404).send({ error: { message: 'Building not found', code: 'NOT_FOUND' } })
      }

      const rows = await prisma.groupBuildingAccess.findMany({
        where: { buildingId: id },
        include: {
          group: {
            select: { id: true, name: true, description: true, _count: { select: { members: true } } },
          },
        },
        orderBy: { group: { name: 'asc' } },
      })

      return reply.status(200).send({ data: rows.map((r) => r.group) })
    },
  )

  // POST /buildings/:id/access-groups — grant a group access to this building
  fastify.post(
    '/:id/access-groups',
    { preHandler: [requireAuth, requireGlobalRole(GlobalRole.SUPER_ADMIN)] },
    async (request, reply) => {
      const { id } = request.params as { id: string }
      const bodyResult = z.object({ groupId: z.string().min(1) }).safeParse(request.body)
      if (!bodyResult.success) {
        return reply.status(400).send({ error: { message: 'groupId required', code: 'VALIDATION_ERROR' } })
      }
      const { groupId } = bodyResult.data

      const [building, group] = await Promise.all([
        prisma.building.findUnique({ where: { id } }),
        prisma.userGroup.findUnique({ where: { id: groupId } }),
      ])

      if (!building) return reply.status(404).send({ error: { message: 'Building not found', code: 'NOT_FOUND' } })
      if (!group) return reply.status(404).send({ error: { message: 'Group not found', code: 'NOT_FOUND' } })

      try {
        await prisma.groupBuildingAccess.create({ data: { groupId, buildingId: id } })
        return reply.status(201).send({ data: { groupId, buildingId: id } })
      } catch {
        return reply.status(409).send({ error: { message: 'Access rule already exists', code: 'ALREADY_EXISTS' } })
      }
    },
  )

  // DELETE /buildings/:id/access-groups/:groupId — revoke a group's access
  fastify.delete(
    '/:id/access-groups/:groupId',
    { preHandler: [requireAuth, requireGlobalRole(GlobalRole.SUPER_ADMIN)] },
    async (request, reply) => {
      const { id, groupId } = request.params as { id: string; groupId: string }

      try {
        await prisma.groupBuildingAccess.delete({
          where: { groupId_buildingId: { groupId, buildingId: id } },
        })
        return reply.status(200).send({ data: { ok: true } })
      } catch {
        return reply.status(404).send({ error: { message: 'Access rule not found', code: 'NOT_FOUND' } })
      }
    },
  )

  // ─── Building manager management (SUPER_ADMIN) ───────────────────────────

  // GET /buildings/:id/managers — list individual building managers
  fastify.get(
    '/:id/managers',
    { preHandler: [requireAuth, requireGlobalRole(GlobalRole.SUPER_ADMIN)] },
    async (request, reply) => {
      const { id } = request.params as { id: string }

      const roles = await prisma.userResourceRole.findMany({
        where: { scopeType: 'BUILDING', buildingId: id, role: 'BUILDING_ADMIN' },
        include: {
          user: { select: { id: true, displayName: true, email: true } },
        },
        orderBy: { createdAt: 'asc' },
      })

      return reply.status(200).send({ data: roles.map((r) => ({ roleId: r.id, ...r.user })) })
    },
  )

  // POST /buildings/:id/managers — assign a user as building manager
  fastify.post(
    '/:id/managers',
    { preHandler: [requireAuth, requireGlobalRole(GlobalRole.SUPER_ADMIN)] },
    async (request, reply) => {
      const { id } = request.params as { id: string }
      const bodyResult = z.object({ userId: z.string().min(1) }).safeParse(request.body)
      if (!bodyResult.success) {
        return reply.status(400).send({ error: { message: 'userId is required', code: 'VALIDATION_ERROR' } })
      }
      const { userId } = bodyResult.data

      const [building, user] = await Promise.all([
        prisma.building.findUnique({ where: { id } }),
        prisma.user.findUnique({ where: { id: userId } }),
      ])

      if (!building) return reply.status(404).send({ error: { message: 'Building not found', code: 'NOT_FOUND' } })
      if (!user) return reply.status(404).send({ error: { message: 'User not found', code: 'NOT_FOUND' } })

      // The unique index on UserResourceRole is (userId, scopeType, buildingId,
      // floorId), but building-scope rows always have floorId NULL — Postgres
      // treats NULL <> NULL for uniqueness, so that constraint never actually
      // fires here and the same user could be assigned twice as building
      // manager. The group-manager endpoint below already guards against its
      // equivalent case with an explicit findFirst; this one didn't.
      const existing = await prisma.userResourceRole.findFirst({
        where: { userId, scopeType: 'BUILDING', buildingId: id, role: 'BUILDING_ADMIN' },
      })
      if (existing) {
        return reply.status(409).send({ error: { message: 'User is already a building manager', code: 'ALREADY_EXISTS' } })
      }

      const role = await prisma.userResourceRole.create({
        data: { userId, role: 'BUILDING_ADMIN', scopeType: 'BUILDING', buildingId: id },
      })
      return reply.status(201).send({ data: { roleId: role.id, id: user.id, displayName: user.displayName, email: user.email } })
    },
  )

  // DELETE /buildings/:id/managers/:userId — remove a user building manager
  fastify.delete(
    '/:id/managers/:userId',
    { preHandler: [requireAuth, requireGlobalRole(GlobalRole.SUPER_ADMIN)] },
    async (request, reply) => {
      const { id, userId } = request.params as { id: string; userId: string }

      // deleteMany (not findFirst+delete) so any duplicate grant already
      // sitting in the DB from before the create-side dedupe fix above is
      // fully cleared in one removal, rather than leaving a leftover row
      // that keeps the user's access live after the admin was told it was removed.
      const result = await prisma.userResourceRole.deleteMany({
        where: { userId, scopeType: 'BUILDING', buildingId: id, role: 'BUILDING_ADMIN' },
      })
      if (result.count === 0) {
        return reply.status(404).send({ error: { message: 'Manager role not found', code: 'NOT_FOUND' } })
      }
      return reply.status(200).send({ data: { ok: true } })
    },
  )

  // GET /buildings/:id/group-managers — list group building managers
  fastify.get(
    '/:id/group-managers',
    { preHandler: [requireAuth, requireGlobalRole(GlobalRole.SUPER_ADMIN)] },
    async (request, reply) => {
      const { id } = request.params as { id: string }

      const roles = await prisma.groupResourceRole.findMany({
        where: { scopeType: 'BUILDING', buildingId: id, role: 'BUILDING_ADMIN' },
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

  // POST /buildings/:id/group-managers — assign a group as building manager
  fastify.post(
    '/:id/group-managers',
    { preHandler: [requireAuth, requireGlobalRole(GlobalRole.SUPER_ADMIN)] },
    async (request, reply) => {
      const { id } = request.params as { id: string }
      const bodyResult = z.object({ groupId: z.string().min(1) }).safeParse(request.body)
      if (!bodyResult.success) {
        return reply.status(400).send({ error: { message: 'groupId is required', code: 'VALIDATION_ERROR' } })
      }
      const { groupId } = bodyResult.data

      const [building, group] = await Promise.all([
        prisma.building.findUnique({ where: { id } }),
        prisma.userGroup.findUnique({ where: { id: groupId } }),
      ])

      if (!building) return reply.status(404).send({ error: { message: 'Building not found', code: 'NOT_FOUND' } })
      if (!group) return reply.status(404).send({ error: { message: 'Group not found', code: 'NOT_FOUND' } })

      const existing = await prisma.groupResourceRole.findFirst({
        where: { groupId, scopeType: 'BUILDING', buildingId: id },
      })
      if (existing) {
        return reply.status(409).send({ error: { message: 'Group is already a building manager', code: 'ALREADY_EXISTS' } })
      }

      const role = await prisma.groupResourceRole.create({
        data: { groupId, role: 'BUILDING_ADMIN', scopeType: 'BUILDING', buildingId: id },
      })

      return reply.status(201).send({ data: { roleId: role.id, id: group.id, name: group.name, memberCount: 0 } })
    },
  )

  // DELETE /buildings/:id/group-managers/:groupId — remove a group building manager
  fastify.delete(
    '/:id/group-managers/:groupId',
    { preHandler: [requireAuth, requireGlobalRole(GlobalRole.SUPER_ADMIN)] },
    async (request, reply) => {
      const { id, groupId } = request.params as { id: string; groupId: string }

      const role = await prisma.groupResourceRole.findFirst({
        where: { groupId, scopeType: 'BUILDING', buildingId: id, role: 'BUILDING_ADMIN' },
      })
      if (!role) {
        return reply.status(404).send({ error: { message: 'Group role not found', code: 'NOT_FOUND' } })
      }

      await prisma.groupResourceRole.delete({ where: { id: role.id } })
      return reply.status(200).send({ data: { ok: true } })
    },
  )

  // PUT /buildings/:id — update building (SUPER_ADMIN)  
  fastify.put(
    '/:id',
    { preHandler: [requireAuth, requireGlobalRole(GlobalRole.SUPER_ADMIN)] },
    async (request, reply) => {
      const { id } = request.params as { id: string }
      const result = updateBuildingSchema.safeParse(request.body)
      if (!result.success) {
        return reply.status(400).send({
          error: { message: 'Validation failed', code: 'VALIDATION_ERROR', details: result.error.flatten() },
        })
      }

      try {
        const building = await prisma.building.update({
          where: { id },
          data: result.data,
        })
        return reply.status(200).send({ data: building })
      } catch {
        return reply.status(404).send({
          error: { message: 'Building not found', code: 'NOT_FOUND' },
        })
      }
    },
  )

  // DELETE /buildings/:id (SUPER_ADMIN)
  fastify.delete(
    '/:id',
    { preHandler: [requireAuth, requireGlobalRole(GlobalRole.SUPER_ADMIN)] },
    async (request, reply) => {
      const { id } = request.params as { id: string }

      // Must run before the delete: once the building (and its floors, which
      // cascade-delete with it) is gone, Asset.floorId is SetNull and there's
      // no longer any way to find which bookings were on those floors.
      const floors = await prisma.floor.findMany({ where: { buildingId: id }, select: { id: true } })
      await cancelFutureBookingsForFloors(floors.map((f) => f.id))

      // Also fetch before the delete — each floor's FloorPlan cascades away
      // with it, but the files on disk don't clean themselves up.
      const floorPlans = await prisma.floorPlan.findMany({
        where: { floorId: { in: floors.map((f) => f.id) } },
      })

      try {
        await prisma.building.delete({ where: { id } })
      } catch {
        return reply.status(404).send({
          error: { message: 'Building not found', code: 'NOT_FOUND' },
        })
      }

      for (const plan of floorPlans) {
        await deleteFile(plan.originalPath)
        if (plan.renderedPath !== plan.originalPath) {
          await deleteFile(plan.renderedPath)
        }
        if (plan.thumbnailPath) {
          await deleteFile(plan.thumbnailPath)
        }
      }

      return reply.status(200).send({ data: { ok: true } })
    },
  )
}
