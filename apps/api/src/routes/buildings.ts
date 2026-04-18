import type { FastifyInstance } from 'fastify'
import { prisma } from '../lib/prisma'
import { createBuildingSchema, updateBuildingSchema } from '@roomer/shared'
import { requireAuth } from '../middleware/requireAuth'
import { requireGlobalRole } from '../middleware/requireRole'
import { GlobalRole } from '@roomer/shared'
import { canUserAccessBuilding } from './groups'
export async function buildingRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.addHook('onRoute', (route) => { route.schema = { tags: ['Buildings'], ...route.schema } })

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

    // For regular users: return open buildings plus any restricted buildings
    // their groups grant access to.
    const userGroupIds = (
      await prisma.userGroupMember.findMany({
        where: { userId: request.user.id },
        select: { groupId: true },
      })
    ).map((m) => m.groupId)

    const buildings = await prisma.building.findMany({
      where: {
        OR: [
          { groupAccess: { none: {} } },                                    // open
          { groupAccess: { some: { groupId: { in: userGroupIds } } } },     // user's group has access
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
      const { groupId } = request.body as { groupId?: string }

      if (!groupId) {
        return reply.status(400).send({ error: { message: 'groupId required', code: 'VALIDATION_ERROR' } })
      }

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
      const { userId } = request.body as { userId?: string }

      if (!userId) {
        return reply.status(400).send({ error: { message: 'userId is required', code: 'VALIDATION_ERROR' } })
      }

      const [building, user] = await Promise.all([
        prisma.building.findUnique({ where: { id } }),
        prisma.user.findUnique({ where: { id: userId } }),
      ])

      if (!building) return reply.status(404).send({ error: { message: 'Building not found', code: 'NOT_FOUND' } })
      if (!user) return reply.status(404).send({ error: { message: 'User not found', code: 'NOT_FOUND' } })

      try {
        const role = await prisma.userResourceRole.create({
          data: { userId, role: 'BUILDING_ADMIN', scopeType: 'BUILDING', buildingId: id },
        })
        return reply.status(201).send({ data: { roleId: role.id, id: user.id, displayName: user.displayName, email: user.email } })
      } catch {
        return reply.status(409).send({ error: { message: 'User is already a building manager', code: 'ALREADY_EXISTS' } })
      }
    },
  )

  // DELETE /buildings/:id/managers/:userId — remove a user building manager
  fastify.delete(
    '/:id/managers/:userId',
    { preHandler: [requireAuth, requireGlobalRole(GlobalRole.SUPER_ADMIN)] },
    async (request, reply) => {
      const { id, userId } = request.params as { id: string; userId: string }

      const role = await prisma.userResourceRole.findFirst({
        where: { userId, scopeType: 'BUILDING', buildingId: id, role: 'BUILDING_ADMIN' },
      })
      if (!role) {
        return reply.status(404).send({ error: { message: 'Manager role not found', code: 'NOT_FOUND' } })
      }

      await prisma.userResourceRole.delete({ where: { id: role.id } })
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
      const { groupId } = request.body as { groupId?: string }

      if (!groupId) {
        return reply.status(400).send({ error: { message: 'groupId is required', code: 'VALIDATION_ERROR' } })
      }

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

      try {
        await prisma.building.delete({ where: { id } })
        return reply.status(200).send({ data: { ok: true } })
      } catch {
        return reply.status(404).send({
          error: { message: 'Building not found', code: 'NOT_FOUND' },
        })
      }
    },
  )
}
