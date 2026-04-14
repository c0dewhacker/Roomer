import type { FastifyInstance } from 'fastify'
import { prisma } from '../lib/prisma'
import { GlobalRole } from '@roomer/shared'
import { requireAuth } from '../middleware/requireAuth'
import { requireGlobalRole } from '../middleware/requireRole'
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
      const group = await prisma.userGroup.update({
        where: { id },
        data: result.data,
        include: {
          _count: { select: { members: true } },
          buildingAccess: { include: { building: { select: { id: true, name: true } } } },
          floorAccess: { include: { floor: { select: { id: true, name: true } } } },
        },
      })
      return reply.status(200).send({ data: group })
    } catch {
      return reply.status(404).send({ error: { message: 'Group not found', code: 'NOT_FOUND' } })
    }
  })

  // DELETE /groups/:id
  fastify.delete('/:id', { preHandler: adminHandlers }, async (request, reply) => {
    const { id } = request.params as { id: string }
    try {
      await prisma.userGroup.delete({ where: { id } })
      return reply.status(200).send({ data: { ok: true } })
    } catch {
      return reply.status(404).send({ error: { message: 'Group not found', code: 'NOT_FOUND' } })
    }
  })

  // POST /groups/:id/members — add member
  fastify.post('/:id/members', { preHandler: adminHandlers }, async (request, reply) => {
    const { id } = request.params as { id: string }
    const { userId } = request.body as { userId: string }

    if (!userId) {
      return reply.status(400).send({ error: { message: 'userId required', code: 'VALIDATION_ERROR' } })
    }

    const [group, user] = await Promise.all([
      prisma.userGroup.findUnique({ where: { id } }),
      prisma.user.findUnique({ where: { id: userId } }),
    ])

    if (!group) return reply.status(404).send({ error: { message: 'Group not found', code: 'NOT_FOUND' } })
    if (!user) return reply.status(404).send({ error: { message: 'User not found', code: 'NOT_FOUND' } })

    try {
      await prisma.userGroupMember.create({ data: { groupId: id, userId } })
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
      return reply.status(200).send({ data: { ok: true } })
    } catch {
      return reply.status(404).send({ error: { message: 'Member not found', code: 'NOT_FOUND' } })
    }
  })

  // POST /groups/:id/building-access — add building access rule
  fastify.post('/:id/building-access', { preHandler: adminHandlers }, async (request, reply) => {
    const { id } = request.params as { id: string }
    const { buildingId } = request.body as { buildingId: string }

    if (!buildingId) {
      return reply.status(400).send({ error: { message: 'buildingId required', code: 'VALIDATION_ERROR' } })
    }

    const [group, building] = await Promise.all([
      prisma.userGroup.findUnique({ where: { id } }),
      prisma.building.findUnique({ where: { id: buildingId } }),
    ])

    if (!group) return reply.status(404).send({ error: { message: 'Group not found', code: 'NOT_FOUND' } })
    if (!building) return reply.status(404).send({ error: { message: 'Building not found', code: 'NOT_FOUND' } })

    try {
      await prisma.groupBuildingAccess.create({ data: { groupId: id, buildingId } })
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
      return reply.status(200).send({ data: { ok: true } })
    } catch {
      return reply.status(404).send({ error: { message: 'Access rule not found', code: 'NOT_FOUND' } })
    }
  })

  // POST /groups/:id/floor-access — add floor access rule
  fastify.post('/:id/floor-access', { preHandler: adminHandlers }, async (request, reply) => {
    const { id } = request.params as { id: string }
    const { floorId } = request.body as { floorId: string }

    if (!floorId) {
      return reply.status(400).send({ error: { message: 'floorId required', code: 'VALIDATION_ERROR' } })
    }

    const [group, floor] = await Promise.all([
      prisma.userGroup.findUnique({ where: { id } }),
      prisma.floor.findUnique({ where: { id: floorId } }),
    ])

    if (!group) return reply.status(404).send({ error: { message: 'Group not found', code: 'NOT_FOUND' } })
    if (!floor) return reply.status(404).send({ error: { message: 'Floor not found', code: 'NOT_FOUND' } })

    try {
      await prisma.groupFloorAccess.create({ data: { groupId: id, floorId } })
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
      return reply.status(200).send({ data: { ok: true } })
    } catch {
      return reply.status(404).send({ error: { message: 'Access rule not found', code: 'NOT_FOUND' } })
    }
  })
}

// ─── Access check helper (used by booking validation) ────────────────────────

/**
 * Returns true if the user is allowed to book a desk in the given building/floor.
 * Logic: if the user belongs to ANY group that has building/floor restrictions, they
 * must match at least one allowed building OR floor rule.
 * Users with no group restrictions, or not in any restricted group, pass freely.
 */
export async function checkGroupAccess(
  userId: string,
  buildingId: string,
  floorId: string,
): Promise<boolean> {
  // Get all groups the user belongs to that have any access rules
  const memberships = await prisma.userGroupMember.findMany({
    where: { userId },
    include: {
      group: {
        include: {
          buildingAccess: true,
          floorAccess: true,
        },
      },
    },
  })

  // Filter to groups that have at least one access rule
  const restrictedGroups = memberships
    .map((m) => m.group)
    .filter((g) => g.buildingAccess.length > 0 || g.floorAccess.length > 0)

  if (restrictedGroups.length === 0) {
    // User has no group restrictions
    return true
  }

  // User must be allowed in ALL restricted groups (intersection semantics)
  for (const group of restrictedGroups) {
    const allowedBuildings = group.buildingAccess.map((b) => b.buildingId)
    const allowedFloors = group.floorAccess.map((f) => f.floorId)

    const buildingOk = allowedBuildings.length === 0 || allowedBuildings.includes(buildingId)
    const floorOk = allowedFloors.length === 0 || allowedFloors.includes(floorId)

    if (!buildingOk && !floorOk) {
      return false
    }

    // If building rules exist but this building isn't in them, check if a floor rule grants access
    if (allowedBuildings.length > 0 && !allowedBuildings.includes(buildingId)) {
      if (!floorOk) return false
    }
  }

  return true
}
