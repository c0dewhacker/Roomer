import type { FastifyRequest, FastifyReply } from 'fastify'
import { GlobalRole, ResourceRoleType, ResourceScopeType } from '@roomer/shared'
import { prisma } from '../lib/prisma'

const ROLE_HIERARCHY: Record<ResourceRoleType, number> = {
  [ResourceRoleType.VIEWER]: 0,
  [ResourceRoleType.USER]: 1,
  [ResourceRoleType.FLOOR_MANAGER]: 2,
  [ResourceRoleType.BUILDING_ADMIN]: 3,
}

/**
 * Numeric hierarchy for GlobalRole values.
 * A SUPER_ADMIN has a higher level than USER so requireGlobalRole(GlobalRole.USER)
 * admits both USER and SUPER_ADMIN — i.e. "at least this role", not "exactly this role".
 *
 * Previously this used strict equality (=== role) which had two problems:
 *   1. SUPER_ADMINs were denied access to USER-only routes.
 *   2. The semantic meaning was inverted: developers expected "minimum required role"
 *      but got "exact role match".
 */
const GLOBAL_ROLE_HIERARCHY: Record<GlobalRole, number> = {
  [GlobalRole.USER]: 0,
  [GlobalRole.SUPER_ADMIN]: 1,
}

export function requireGlobalRole(minimumRole: GlobalRole) {
  return async function (request: FastifyRequest, reply: FastifyReply): Promise<void> {
    if (!request.user) {
      return reply.status(401).send({
        error: { message: 'Authentication required', code: 'UNAUTHENTICATED' },
      })
    }

    const userLevel = GLOBAL_ROLE_HIERARCHY[request.user.globalRole as GlobalRole] ?? -1
    const requiredLevel = GLOBAL_ROLE_HIERARCHY[minimumRole] ?? 0

    if (userLevel < requiredLevel) {
      return reply.status(403).send({
        error: { message: 'Insufficient permissions', code: 'FORBIDDEN' },
      })
    }
  }
}

export function requireResourceRole(
  scopeType: ResourceScopeType,
  minimumRole: ResourceRoleType,
  getResourceId: (req: FastifyRequest) => string,
) {
  return async function (request: FastifyRequest, reply: FastifyReply): Promise<void> {
    if (!request.user) {
      return reply.status(401).send({
        error: { message: 'Authentication required', code: 'UNAUTHENTICATED' },
      })
    }

    // Super admins always pass
    if (request.user.globalRole === GlobalRole.SUPER_ADMIN) {
      return
    }

    const resourceId = getResourceId(request)

    const where =
      scopeType === ResourceScopeType.BUILDING
        ? { userId: request.user.id, scopeType, buildingId: resourceId }
        : { userId: request.user.id, scopeType, floorId: resourceId }

    const role = await prisma.userResourceRole.findFirst({ where })

    if (!role) {
      return reply.status(403).send({
        error: { message: 'Insufficient permissions', code: 'FORBIDDEN' },
      })
    }

    const userRoleLevel = ROLE_HIERARCHY[role.role as ResourceRoleType] ?? -1
    const requiredLevel = ROLE_HIERARCHY[minimumRole] ?? 0

    if (userRoleLevel < requiredLevel) {
      return reply.status(403).send({
        error: { message: 'Insufficient permissions', code: 'FORBIDDEN' },
      })
    }
  }
}

// Middleware for desk endpoints: resolves desk → zone → floorId, then checks floor-level role.
// Also passes for SUPER_ADMIN.
export function requireFloorRoleForDesk(minimumRole: ResourceRoleType) {
  return async function (request: FastifyRequest, reply: FastifyReply): Promise<void> {
    if (!request.user) {
      return reply.status(401).send({
        error: { message: 'Authentication required', code: 'UNAUTHENTICATED' },
      })
    }

    if (request.user.globalRole === GlobalRole.SUPER_ADMIN) {
      return
    }

    const { id } = request.params as { id: string }
    const desk = await prisma.desk.findUnique({
      where: { id },
      select: { zone: { select: { floorId: true } } },
    })

    if (!desk) {
      return reply.status(404).send({ error: { message: 'Desk not found', code: 'NOT_FOUND' } })
    }

    const floorId = desk.zone.floorId

    const directRole = await prisma.userResourceRole.findFirst({
      where: { userId: request.user.id, scopeType: ResourceScopeType.FLOOR, floorId },
    })

    const groupRole = directRole ? null : await prisma.groupResourceRole.findFirst({
      where: {
        scopeType: ResourceScopeType.FLOOR,
        floorId,
        group: { members: { some: { userId: request.user.id } } },
      },
    })

    const role = directRole ?? groupRole

    if (!role) {
      return reply.status(403).send({
        error: { message: 'Insufficient permissions', code: 'FORBIDDEN' },
      })
    }

    const userRoleLevel = ROLE_HIERARCHY[role.role as ResourceRoleType] ?? -1
    const requiredLevel = ROLE_HIERARCHY[minimumRole] ?? 0

    if (userRoleLevel < requiredLevel) {
      return reply.status(403).send({
        error: { message: 'Insufficient permissions', code: 'FORBIDDEN' },
      })
    }
  }
}
