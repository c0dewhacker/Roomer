import type { FastifyInstance } from 'fastify'
import { prisma } from '../lib/prisma.js'
import { createBuildingSchema, updateBuildingSchema, GlobalRole } from '@roomer/shared'
import { requireAuth } from '../middleware/requireAuth.js'
import { requireGlobalRole, getManagedBuildingIds, isBuildingManagerForBuilding, RESOURCE_ROLE_GRANT_LOCK_CLASS } from '../middleware/requireRole.js'
import { canUserAccessBuilding } from './groups.js'
import { cancelFutureBookingsForFloors, cancelQueueEntriesForFloors } from '../lib/queue.js'
import { deleteFile } from '../lib/storage.js'
import { LEASE_DOCUMENT_LOCK_CLASS } from './leases.js'
import { recordAuditLog } from '../lib/audit.js'

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
  // (SUPER_ADMIN or building admin for this building — same carve-out as
  // PUT /:id below; BuildingManagerOrAdminRoute already routes building
  // admins onto the page this powers, so this was silently 403ing for them.)
  fastify.get('/:id/access-summary', { preHandler: [requireAuth] }, async (request, reply) => {
    const { id } = request.params as { id: string }

    if (request.user.globalRole !== GlobalRole.SUPER_ADMIN) {
      const canManage = await isBuildingManagerForBuilding(request.user.id, id)
      if (!canManage) {
        return reply.status(403).send({ error: { message: 'Insufficient permissions', code: 'FORBIDDEN' } })
      }
    }

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
      await recordAuditLog(prisma, {
        actorId: request.user.id,
        action: 'building.created',
        resourceType: 'Building',
        resourceId: building.id,
        after: { name: building.name, address: building.address },
        ipAddress: request.ip,
      }, request.log)

      return reply.status(201).send({ data: building })
    },
  )

  // GET /buildings/:id — get building with floors (access-gated)
  fastify.get('/:id', { preHandler: [requireAuth] }, async (request, reply) => {
    const { id } = request.params as { id: string }

    const isAdmin = request.user.globalRole === GlobalRole.SUPER_ADMIN

    // Check building-level access for non-admins. canUserAccessBuilding only
    // considers GroupBuildingAccess — a BUILDING_ADMIN (direct or via group)
    // for a building that's ALSO group-restricted to a different group they
    // aren't in would otherwise 404 on their own building, exactly like the
    // list route's own fix comment below describes ("could never select
    // their own building... even though the backend would authorize the
    // request once made").
    if (!isAdmin) {
      const [hasAccess, adminBuildingIds] = await Promise.all([
        canUserAccessBuilding(request.user.id, id),
        getManagedBuildingIds(request.user.id),
      ])
      if (!hasAccess && !adminBuildingIds.includes(id)) {
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
    { preHandler: [requireAuth] },
    async (request, reply) => {
      const { id } = request.params as { id: string }

      if (request.user.globalRole !== GlobalRole.SUPER_ADMIN) {
        const canManage = await isBuildingManagerForBuilding(request.user.id, id)
        if (!canManage) {
          return reply.status(403).send({ error: { message: 'Insufficient permissions', code: 'FORBIDDEN' } })
        }
      }

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
    { preHandler: [requireAuth] },
    async (request, reply) => {
      const { id } = request.params as { id: string }

      if (request.user.globalRole !== GlobalRole.SUPER_ADMIN) {
        const canManage = await isBuildingManagerForBuilding(request.user.id, id)
        if (!canManage) {
          return reply.status(403).send({ error: { message: 'Insufficient permissions', code: 'FORBIDDEN' } })
        }
      }

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
        await recordAuditLog(prisma, {
          actorId: request.user.id,
          action: 'group_building_access.granted',
          resourceType: 'GroupBuildingAccess',
          resourceId: `${groupId}:${id}`,
          after: { groupId, buildingId: id },
          ipAddress: request.ip,
        }, request.log)
        return reply.status(201).send({ data: { groupId, buildingId: id } })
      } catch {
        return reply.status(409).send({ error: { message: 'Access rule already exists', code: 'ALREADY_EXISTS' } })
      }
    },
  )

  // DELETE /buildings/:id/access-groups/:groupId — revoke a group's access
  fastify.delete(
    '/:id/access-groups/:groupId',
    { preHandler: [requireAuth] },
    async (request, reply) => {
      const { id, groupId } = request.params as { id: string; groupId: string }

      if (request.user.globalRole !== GlobalRole.SUPER_ADMIN) {
        const canManage = await isBuildingManagerForBuilding(request.user.id, id)
        if (!canManage) {
          return reply.status(403).send({ error: { message: 'Insufficient permissions', code: 'FORBIDDEN' } })
        }
      }

      try {
        await prisma.groupBuildingAccess.delete({
          where: { groupId_buildingId: { groupId, buildingId: id } },
        })
        await recordAuditLog(prisma, {
          actorId: request.user.id,
          action: 'group_building_access.revoked',
          resourceType: 'GroupBuildingAccess',
          resourceId: `${groupId}:${id}`,
          before: { groupId, buildingId: id },
          ipAddress: request.ip,
        }, request.log)
        return reply.status(200).send({ data: { ok: true } })
      } catch {
        return reply.status(404).send({ error: { message: 'Access rule not found', code: 'NOT_FOUND' } })
      }
    },
  )

  // ─── Building manager management (SUPER_ADMIN or building admin) ────────

  // GET /buildings/:id/managers — list individual building managers
  fastify.get(
    '/:id/managers',
    { preHandler: [requireAuth] },
    async (request, reply) => {
      const { id } = request.params as { id: string }

      if (request.user.globalRole !== GlobalRole.SUPER_ADMIN) {
        const canManage = await isBuildingManagerForBuilding(request.user.id, id)
        if (!canManage) {
          return reply.status(403).send({ error: { message: 'Insufficient permissions', code: 'FORBIDDEN' } })
        }
      }

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
    { preHandler: [requireAuth] },
    async (request, reply) => {
      const { id } = request.params as { id: string }

      if (request.user.globalRole !== GlobalRole.SUPER_ADMIN) {
        const canManage = await isBuildingManagerForBuilding(request.user.id, id)
        if (!canManage) {
          return reply.status(403).send({ error: { message: 'Insufficient permissions', code: 'FORBIDDEN' } })
        }
      }

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
      await recordAuditLog(prisma, {
        actorId: request.user.id,
        action: 'user_resource_role.granted',
        resourceType: 'UserResourceRole',
        resourceId: role.id,
        after: { userId, role: 'BUILDING_ADMIN', scopeType: 'BUILDING', buildingId: id },
        ipAddress: request.ip,
      }, request.log)
      return reply.status(201).send({ data: { roleId: role.id, id: user.id, displayName: user.displayName, email: user.email } })
    },
  )

  // DELETE /buildings/:id/managers/:userId — remove a user building manager
  fastify.delete(
    '/:id/managers/:userId',
    { preHandler: [requireAuth] },
    async (request, reply) => {
      const { id, userId } = request.params as { id: string; userId: string }

      if (request.user.globalRole !== GlobalRole.SUPER_ADMIN) {
        const canManage = await isBuildingManagerForBuilding(request.user.id, id)
        if (!canManage) {
          return reply.status(403).send({ error: { message: 'Insufficient permissions', code: 'FORBIDDEN' } })
        }
      }

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
      await recordAuditLog(prisma, {
        actorId: request.user.id,
        action: 'user_resource_role.revoked',
        resourceType: 'UserResourceRole',
        resourceId: `${userId}:BUILDING:${id}`,
        before: { userId, role: 'BUILDING_ADMIN', scopeType: 'BUILDING', buildingId: id, deletedCount: result.count },
        ipAddress: request.ip,
      }, request.log)
      return reply.status(200).send({ data: { ok: true } })
    },
  )

  // GET /buildings/:id/group-managers — list group building managers
  fastify.get(
    '/:id/group-managers',
    { preHandler: [requireAuth] },
    async (request, reply) => {
      const { id } = request.params as { id: string }

      if (request.user.globalRole !== GlobalRole.SUPER_ADMIN) {
        const canManage = await isBuildingManagerForBuilding(request.user.id, id)
        if (!canManage) {
          return reply.status(403).send({ error: { message: 'Insufficient permissions', code: 'FORBIDDEN' } })
        }
      }

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
    { preHandler: [requireAuth] },
    async (request, reply) => {
      const { id } = request.params as { id: string }

      if (request.user.globalRole !== GlobalRole.SUPER_ADMIN) {
        const canManage = await isBuildingManagerForBuilding(request.user.id, id)
        if (!canManage) {
          return reply.status(403).send({ error: { message: 'Insufficient permissions', code: 'FORBIDDEN' } })
        }
      }

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

      // See RESOURCE_ROLE_GRANT_LOCK_CLASS's doc comment — the find-then-create
      // below needs a lock, not just the pre-check, since GroupResourceRole's
      // unique constraint never actually fires for either scope.
      const role = await prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(${RESOURCE_ROLE_GRANT_LOCK_CLASS}, hashtext(${`${groupId}:BUILDING:${id}`}))`
        const existing = await tx.groupResourceRole.findFirst({
          where: { groupId, scopeType: 'BUILDING', buildingId: id },
        })
        if (existing) {
          throw Object.assign(new Error('ALREADY_EXISTS'), { code: 'ALREADY_EXISTS' })
        }
        return tx.groupResourceRole.create({
          data: { groupId, role: 'BUILDING_ADMIN', scopeType: 'BUILDING', buildingId: id },
        })
      }).catch((err) => {
        if ((err as { code?: string })?.code === 'ALREADY_EXISTS') return null
        throw err
      })
      if (!role) {
        return reply.status(409).send({ error: { message: 'Group is already a building manager', code: 'ALREADY_EXISTS' } })
      }
      await recordAuditLog(prisma, {
        actorId: request.user.id,
        action: 'group_resource_role.granted',
        resourceType: 'GroupResourceRole',
        resourceId: role.id,
        after: { groupId, role: 'BUILDING_ADMIN', scopeType: 'BUILDING', buildingId: id },
        ipAddress: request.ip,
      }, request.log)

      return reply.status(201).send({ data: { roleId: role.id, id: group.id, name: group.name, memberCount: 0 } })
    },
  )

  // DELETE /buildings/:id/group-managers/:groupId — remove a group building manager
  fastify.delete(
    '/:id/group-managers/:groupId',
    { preHandler: [requireAuth] },
    async (request, reply) => {
      const { id, groupId } = request.params as { id: string; groupId: string }

      if (request.user.globalRole !== GlobalRole.SUPER_ADMIN) {
        const canManage = await isBuildingManagerForBuilding(request.user.id, id)
        if (!canManage) {
          return reply.status(403).send({ error: { message: 'Insufficient permissions', code: 'FORBIDDEN' } })
        }
      }

      const role = await prisma.groupResourceRole.findFirst({
        where: { groupId, scopeType: 'BUILDING', buildingId: id, role: 'BUILDING_ADMIN' },
      })
      if (!role) {
        return reply.status(404).send({ error: { message: 'Group role not found', code: 'NOT_FOUND' } })
      }

      // deleteMany on the full scope filter, not delete-by-id — the grant
      // side's unique constraint never actually fires (see
      // RESOURCE_ROLE_GRANT_LOCK_CLASS), so a race could have left more than
      // one row for this exact group+building+role. Deleting only the one
      // row this findFirst happened to return left the others (and
      // therefore the access) silently in place despite an apparently
      // successful revoke.
      await prisma.groupResourceRole.deleteMany({ where: { groupId, scopeType: 'BUILDING', buildingId: id, role: 'BUILDING_ADMIN' } })
      await recordAuditLog(prisma, {
        actorId: request.user.id,
        action: 'group_resource_role.revoked',
        resourceType: 'GroupResourceRole',
        resourceId: role.id,
        before: { groupId, role: 'BUILDING_ADMIN', scopeType: 'BUILDING', buildingId: id },
        ipAddress: request.ip,
      }, request.log)
      return reply.status(200).send({ data: { ok: true } })
    },
  )

  // PUT /buildings/:id — update building (SUPER_ADMIN or building admin for
  // this building). updateBuildingSchema's fields (name/address plus the
  // noShowReleaseEnabled/qrCheckInMode/requiresApproval/timezone/working-
  // hours overrides) are exactly what BuildingDetailAdminPage renders for a
  // building admin, routed to them via BuildingManagerOrAdminRoute — this
  // was still SUPER_ADMIN-only, so a building admin could never save any of
  // it for their own building. PUT /floors/:id already gets this right via
  // isFloorManagerForFloor; mirrors that here.
  fastify.put(
    '/:id',
    { preHandler: [requireAuth] },
    async (request, reply) => {
      const { id } = request.params as { id: string }

      if (request.user.globalRole !== GlobalRole.SUPER_ADMIN) {
        const canManage = await isBuildingManagerForBuilding(request.user.id, id)
        if (!canManage) {
          return reply.status(403).send({ error: { message: 'Insufficient permissions', code: 'FORBIDDEN' } })
        }
      }

      const result = updateBuildingSchema.safeParse(request.body)
      if (!result.success) {
        return reply.status(400).send({
          error: { message: 'Validation failed', code: 'VALIDATION_ERROR', details: result.error.flatten() },
        })
      }

      try {
        const before = await prisma.building.findUnique({ where: { id }, select: { name: true, address: true } })
        const building = await prisma.building.update({
          where: { id },
          data: result.data,
        })
        await recordAuditLog(prisma, {
          actorId: request.user.id,
          action: 'building.updated',
          resourceType: 'Building',
          resourceId: id,
          before,
          after: { name: building.name, address: building.address },
          ipAddress: request.ip,
        }, request.log)
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
      // Same policy for queue entries — see floors.ts DELETE /:id.
      await cancelQueueEntriesForFloors(floors.map((f) => f.id))

      // Lease ids under this building — buildingId on a lease doesn't change
      // after creation, so this read is safe outside the lock below; it's
      // only used to know which per-lease locks to acquire.
      const leaseIds = (await prisma.buildingLease.findMany({ where: { buildingId: id }, select: { id: true } })).map((l) => l.id)

      // The pre-delete asset/floor-plan/lease-document snapshot and the
      // delete itself run inside one transaction, locking every floor row
      // under this building first — same race and fix shape as
      // zones.ts/floors.ts DELETE /:id. Asset.floorId's FK checks against
      // the Floor row, not the Building row directly, so a concurrent PATCH
      // /assets/:id that places an asset onto one of this building's floors
      // needs a lock on that same row; locking it here means Postgres
      // blocks that write until we commit, then it fails outright (the
      // floor being gone via cascade) instead of racing our snapshot below.
      //
      // floorPlans/leaseDocuments are read here too, not before this
      // transaction — same reasoning as floors.ts DELETE /:id's own fix: a
      // floor-plan upload (locks its own Floor row, already covered by the
      // FOR UPDATE below) or a lease-document upload (locks
      // LEASE_DOCUMENT_LOCK_CLASS per lease id, NOT a Floor row, so it needs
      // its own explicit acquire here) that commits in the gap would
      // otherwise be invisible to a snapshot taken before the lock, leaking
      // its file on disk once the cascade removes its DB row with no
      // matching cleanup entry.
      const result = await prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM "Floor" WHERE "buildingId" = ${id} FOR UPDATE`
        for (const leaseId of leaseIds) {
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(${LEASE_DOCUMENT_LOCK_CLASS}, hashtext(${leaseId}))`
        }
        const before = await tx.building.findUnique({ where: { id }, select: { name: true, address: true } })
        if (!before) return null
        const buildingAssetIds = (await tx.asset.findMany({ where: { floor: { buildingId: id } }, select: { id: true } })).map((a) => a.id)
        const floorPlans = await tx.floorPlan.findMany({ where: { floorId: { in: floors.map((f) => f.id) } } })
        const leaseDocuments = await tx.leaseDocument.findMany({ where: { lease: { buildingId: id } }, select: { storagePath: true } })
        await tx.building.delete({ where: { id } })
        if (buildingAssetIds.length > 0) {
          // Floor/Zone cascade-delete with the building, so Asset.floorId/
          // primaryZoneId SetNull automatically, but stale x/y/width/height/
          // rotation survive — same "vanishes into a gap no admin screen can
          // reach" issue as deleting a zone or floor (#206), just missing
          // here for the building-level cascade until now.
          await tx.asset.updateMany({
            where: { id: { in: buildingAssetIds } },
            data: { x: null, y: null, width: null, height: null, rotation: null },
          })
        }
        return { before, floorPlans, leaseDocuments }
      }).catch(() => null)

      if (!result) {
        return reply.status(404).send({
          error: { message: 'Building not found', code: 'NOT_FOUND' },
        })
      }
      const { before: buildingBefore, floorPlans, leaseDocuments } = result
      await recordAuditLog(prisma, {
        actorId: request.user.id,
        action: 'building.deleted',
        resourceType: 'Building',
        resourceId: id,
        before: buildingBefore,
        ipAddress: request.ip,
      }, request.log)

      for (const plan of floorPlans) {
        await deleteFile(plan.originalPath)
        if (plan.renderedPath !== plan.originalPath) {
          await deleteFile(plan.renderedPath)
        }
        if (plan.thumbnailPath) {
          await deleteFile(plan.thumbnailPath)
        }
      }
      for (const doc of leaseDocuments) {
        await deleteFile(doc.storagePath)
      }

      return reply.status(200).send({ data: { ok: true } })
    },
  )
}
