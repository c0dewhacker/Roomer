import type { FastifyInstance } from 'fastify'
import { prisma } from '../lib/prisma.js'
import { GlobalRole } from '@roomer/shared'
import { requireAuth } from '../middleware/requireAuth.js'
import { requireGlobalRole } from '../middleware/requireRole.js'
import { recordAuditLog } from '../lib/audit.js'
import { z } from 'zod'

const globalRoleEnum = z.enum([GlobalRole.USER, GlobalRole.SUPER_ADMIN])

const createGroupSchema = z.object({
  name: z.string().min(1).max(255),
  description: z.string().optional(),
  globalRole: globalRoleEnum.optional(),
})

const updateGroupSchema = z.object({
  name: z.string().min(1).max(255).optional(),
  description: z.string().optional(),
  globalRole: globalRoleEnum.optional(),
})

const adminHandlers = [requireAuth, requireGlobalRole(GlobalRole.SUPER_ADMIN)]

// Helper: get the org id for the request (single-org system — use first org)
async function getOrgId(): Promise<string> {
  const org = await prisma.organisation.findFirst()
  if (!org) throw new Error('No organisation found')
  return org.id
}

export async function groupRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.addHook('onRoute', (route) => { route.schema = { tags: ['Groups'], ...route.schema } })

  // GET /groups — list all groups
  fastify.get('/', { preHandler: adminHandlers }, async (_request, reply) => {
    const groups = await prisma.userGroup.findMany({
      include: {
        _count: { select: { members: true } },
        buildingAccess: { include: { building: { select: { id: true, name: true } } } },
        floorAccess: { include: { floor: { select: { id: true, name: true } } } },
      },
      orderBy: { name: 'asc' },
    })
    return reply.status(200).send({ data: groups })
  })

  // POST /groups — create group
  fastify.post('/', { preHandler: adminHandlers }, async (request, reply) => {
    const result = createGroupSchema.safeParse(request.body)
    if (!result.success) {
      return reply.status(400).send({
        error: { message: 'Validation failed', code: 'VALIDATION_ERROR', details: result.error.flatten() },
      })
    }

    const orgId = await getOrgId()

    try {
      const group = await prisma.userGroup.create({
        data: {
          organisationId: orgId,
          name: result.data.name,
          description: result.data.description ?? null,
          globalRole: result.data.globalRole ?? GlobalRole.USER,
        },
        include: {
          _count: { select: { members: true } },
          buildingAccess: { include: { building: { select: { id: true, name: true } } } },
          floorAccess: { include: { floor: { select: { id: true, name: true } } } },
        },
      })
      await recordAuditLog(prisma, {
        actorId: request.user.id,
        action: 'user_group.created',
        resourceType: 'UserGroup',
        resourceId: group.id,
        after: { name: group.name, description: group.description, globalRole: group.globalRole },
        ipAddress: request.ip,
      }, request.log)
      return reply.status(201).send({ data: group })
    } catch {
      return reply.status(409).send({ error: { message: 'Group name already exists', code: 'ALREADY_EXISTS' } })
    }
  })

  // GET /groups/:id — get group detail with members
  fastify.get('/:id', { preHandler: adminHandlers }, async (request, reply) => {
    const { id } = request.params as { id: string }

    const group = await prisma.userGroup.findUnique({
      where: { id },
      include: {
        members: {
          include: { user: { select: { id: true, displayName: true, email: true } } },
          orderBy: { createdAt: 'asc' },
        },
        buildingAccess: {
          include: { building: { select: { id: true, name: true } } },
        },
        floorAccess: {
          include: { floor: { select: { id: true, name: true, buildingId: true } } },
        },
      },
    })

    if (!group) {
      return reply.status(404).send({ error: { message: 'Group not found', code: 'NOT_FOUND' } })
    }

    return reply.status(200).send({ data: group })
  })

  // PUT /groups/:id — update group
  fastify.put('/:id', { preHandler: adminHandlers }, async (request, reply) => {
    const { id } = request.params as { id: string }
    const result = updateGroupSchema.safeParse(request.body)
    if (!result.success) {
      return reply.status(400).send({
        error: { message: 'Validation failed', code: 'VALIDATION_ERROR', details: result.error.flatten() },
      })
    }

    try {
      const before = await prisma.userGroup.findUnique({ where: { id }, select: { name: true, description: true, globalRole: true } })
      const group = await prisma.userGroup.update({
        where: { id },
        data: result.data,
        include: {
          _count: { select: { members: true } },
          buildingAccess: { include: { building: { select: { id: true, name: true } } } },
          floorAccess: { include: { floor: { select: { id: true, name: true } } } },
        },
      })
      await recordAuditLog(prisma, {
        actorId: request.user.id,
        action: 'user_group.updated',
        resourceType: 'UserGroup',
        resourceId: id,
        before,
        after: { name: group.name, description: group.description, globalRole: group.globalRole },
        ipAddress: request.ip,
      }, request.log)
      return reply.status(200).send({ data: group })
    } catch {
      return reply.status(404).send({ error: { message: 'Group not found', code: 'NOT_FOUND' } })
    }
  })

  // DELETE /groups/:id
  fastify.delete('/:id', { preHandler: adminHandlers }, async (request, reply) => {
    const { id } = request.params as { id: string }
    try {
      const deleted = await prisma.userGroup.delete({ where: { id } })
      await recordAuditLog(prisma, {
        actorId: request.user.id,
        action: 'user_group.deleted',
        resourceType: 'UserGroup',
        resourceId: id,
        before: { name: deleted.name, description: deleted.description, globalRole: deleted.globalRole },
        ipAddress: request.ip,
      }, request.log)
      return reply.status(200).send({ data: { ok: true } })
    } catch {
      return reply.status(404).send({ error: { message: 'Group not found', code: 'NOT_FOUND' } })
    }
  })

  // POST /groups/:id/members — add member
  fastify.post('/:id/members', { preHandler: adminHandlers }, async (request, reply) => {
    const { id } = request.params as { id: string }
    const bodyResult = z.object({ userId: z.string().min(1) }).safeParse(request.body)
    if (!bodyResult.success) {
      return reply.status(400).send({ error: { message: 'userId required', code: 'VALIDATION_ERROR' } })
    }
    const { userId } = bodyResult.data

    const [group, user] = await Promise.all([
      prisma.userGroup.findUnique({ where: { id } }),
      prisma.user.findUnique({ where: { id: userId } }),
    ])

    if (!group) return reply.status(404).send({ error: { message: 'Group not found', code: 'NOT_FOUND' } })
    if (!user) return reply.status(404).send({ error: { message: 'User not found', code: 'NOT_FOUND' } })

    try {
      await prisma.userGroupMember.create({ data: { groupId: id, userId } })
      await recordAuditLog(prisma, {
        actorId: request.user.id,
        action: 'user_group_member.added',
        resourceType: 'UserGroupMember',
        resourceId: `${id}:${userId}`,
        after: { groupId: id, userId },
        ipAddress: request.ip,
      }, request.log)
      return reply.status(201).send({ data: { groupId: id, userId } })
    } catch {
      return reply.status(409).send({ error: { message: 'User already in group', code: 'ALREADY_EXISTS' } })
    }
  })

  // DELETE /groups/:id/members/:userId — remove member
  fastify.delete('/:id/members/:userId', { preHandler: adminHandlers }, async (request, reply) => {
    const { id, userId } = request.params as { id: string; userId: string }

    try {
      await prisma.userGroupMember.delete({ where: { groupId_userId: { groupId: id, userId } } })
      await recordAuditLog(prisma, {
        actorId: request.user.id,
        action: 'user_group_member.removed',
        resourceType: 'UserGroupMember',
        resourceId: `${id}:${userId}`,
        before: { groupId: id, userId },
        ipAddress: request.ip,
      }, request.log)
      return reply.status(200).send({ data: { ok: true } })
    } catch {
      return reply.status(404).send({ error: { message: 'Member not found', code: 'NOT_FOUND' } })
    }
  })

  // POST /groups/:id/building-access — add building access rule
  fastify.post('/:id/building-access', { preHandler: adminHandlers }, async (request, reply) => {
    const { id } = request.params as { id: string }
    const bodyResult = z.object({ buildingId: z.string().min(1) }).safeParse(request.body)
    if (!bodyResult.success) {
      return reply.status(400).send({ error: { message: 'buildingId required', code: 'VALIDATION_ERROR' } })
    }
    const { buildingId } = bodyResult.data

    const [group, building] = await Promise.all([
      prisma.userGroup.findUnique({ where: { id } }),
      prisma.building.findUnique({ where: { id: buildingId } }),
    ])

    if (!group) return reply.status(404).send({ error: { message: 'Group not found', code: 'NOT_FOUND' } })
    if (!building) return reply.status(404).send({ error: { message: 'Building not found', code: 'NOT_FOUND' } })

    try {
      await prisma.groupBuildingAccess.create({ data: { groupId: id, buildingId } })
      await recordAuditLog(prisma, {
        actorId: request.user.id,
        action: 'group_building_access.granted',
        resourceType: 'GroupBuildingAccess',
        resourceId: `${id}:${buildingId}`,
        after: { groupId: id, buildingId },
        ipAddress: request.ip,
      }, request.log)
      return reply.status(201).send({ data: { groupId: id, buildingId } })
    } catch {
      return reply.status(409).send({ error: { message: 'Access rule already exists', code: 'ALREADY_EXISTS' } })
    }
  })

  // DELETE /groups/:id/building-access/:buildingId
  fastify.delete('/:id/building-access/:buildingId', { preHandler: adminHandlers }, async (request, reply) => {
    const { id, buildingId } = request.params as { id: string; buildingId: string }

    try {
      await prisma.groupBuildingAccess.delete({ where: { groupId_buildingId: { groupId: id, buildingId } } })
      await recordAuditLog(prisma, {
        actorId: request.user.id,
        action: 'group_building_access.revoked',
        resourceType: 'GroupBuildingAccess',
        resourceId: `${id}:${buildingId}`,
        before: { groupId: id, buildingId },
        ipAddress: request.ip,
      }, request.log)
      return reply.status(200).send({ data: { ok: true } })
    } catch {
      return reply.status(404).send({ error: { message: 'Access rule not found', code: 'NOT_FOUND' } })
    }
  })

  // POST /groups/:id/floor-access — add floor access rule
  fastify.post('/:id/floor-access', { preHandler: adminHandlers }, async (request, reply) => {
    const { id } = request.params as { id: string }
    const bodyResult = z.object({ floorId: z.string().min(1) }).safeParse(request.body)
    if (!bodyResult.success) {
      return reply.status(400).send({ error: { message: 'floorId required', code: 'VALIDATION_ERROR' } })
    }
    const { floorId } = bodyResult.data

    const [group, floor] = await Promise.all([
      prisma.userGroup.findUnique({ where: { id } }),
      prisma.floor.findUnique({ where: { id: floorId } }),
    ])

    if (!group) return reply.status(404).send({ error: { message: 'Group not found', code: 'NOT_FOUND' } })
    if (!floor) return reply.status(404).send({ error: { message: 'Floor not found', code: 'NOT_FOUND' } })

    try {
      await prisma.groupFloorAccess.create({ data: { groupId: id, floorId } })
      await recordAuditLog(prisma, {
        actorId: request.user.id,
        action: 'group_floor_access.granted',
        resourceType: 'GroupFloorAccess',
        resourceId: `${id}:${floorId}`,
        after: { groupId: id, floorId },
        ipAddress: request.ip,
      }, request.log)
      return reply.status(201).send({ data: { groupId: id, floorId } })
    } catch {
      return reply.status(409).send({ error: { message: 'Access rule already exists', code: 'ALREADY_EXISTS' } })
    }
  })

  // DELETE /groups/:id/floor-access/:floorId
  fastify.delete('/:id/floor-access/:floorId', { preHandler: adminHandlers }, async (request, reply) => {
    const { id, floorId } = request.params as { id: string; floorId: string }

    try {
      await prisma.groupFloorAccess.delete({ where: { groupId_floorId: { groupId: id, floorId } } })
      await recordAuditLog(prisma, {
        actorId: request.user.id,
        action: 'group_floor_access.revoked',
        resourceType: 'GroupFloorAccess',
        resourceId: `${id}:${floorId}`,
        before: { groupId: id, floorId },
        ipAddress: request.ip,
      }, request.log)
      return reply.status(200).send({ data: { ok: true } })
    } catch {
      return reply.status(404).send({ error: { message: 'Access rule not found', code: 'NOT_FOUND' } })
    }
  })
}

// ─── Access check helpers (used by building routes and booking validation) ────

/**
 * Building-centric access check.
 *
 * A building is "restricted" when at least one GroupBuildingAccess row points to it.
 * If restricted, the user must be a member of at least one of those groups.
 * If unrestricted (no rows), any authenticated user can access it.
 *
 * SUPER_ADMINs bypass this check at the route level — this function does not
 * special-case the admin role so it can be used in general queries safely.
 */
export async function canUserAccessBuilding(userId: string, buildingId: string): Promise<boolean> {
  const accessCount = await prisma.groupBuildingAccess.count({ where: { buildingId } })
  if (accessCount === 0) return true  // open building — no restrictions configured

  // Restricted: user must be in at least one of the groups that have access
  const userGroupIds = (
    await prisma.userGroupMember.findMany({ where: { userId }, select: { groupId: true } })
  ).map((m) => m.groupId)

  if (userGroupIds.length === 0) return false

  const match = await prisma.groupBuildingAccess.findFirst({
    where: { buildingId, groupId: { in: userGroupIds } },
  })
  return match !== null
}

/**
 * Floor-centric access check — symmetric with canUserAccessBuilding.
 *
 * A floor is "restricted" when at least one GroupFloorAccess row points to it.
 * If restricted, the user must be a member of at least one of those groups.
 * If unrestricted (no rows), any authenticated user can access it.
 *
 * (Previously this was "user-centric": a floor only excluded users who happened
 * to be in some floor-restricted group, so a user in no such group could reach
 * any floor. That asymmetry with building access was a frequent misconfiguration
 * trap — you couldn't actually lock a floor down. This now mirrors buildings.)
 */
export async function canUserAccessFloor(userId: string, floorId: string): Promise<boolean> {
  const accessCount = await prisma.groupFloorAccess.count({ where: { floorId } })
  if (accessCount === 0) return true  // open floor — no restrictions configured

  const userGroupIds = (
    await prisma.userGroupMember.findMany({ where: { userId }, select: { groupId: true } })
  ).map((m) => m.groupId)

  if (userGroupIds.length === 0) return false

  const match = await prisma.groupFloorAccess.findFirst({
    where: { floorId, groupId: { in: userGroupIds } },
  })
  return match !== null
}

/**
 * Returns true if the user is allowed to book in the given building/floor.
 * Both gates use the same "restricted only if a rule exists, else open" model.
 */
export async function checkGroupAccess(
  userId: string,
  buildingId: string,
  floorId: string,
): Promise<boolean> {
  if (!(await canUserAccessBuilding(userId, buildingId))) return false
  return canUserAccessFloor(userId, floorId)
}
