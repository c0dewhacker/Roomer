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

/**
 * Returns true if the user holds BUILDING_ADMIN access on the given building,
 * either via a direct UserResourceRole or through a GroupResourceRole.
 */
export async function isBuildingManagerForBuilding(userId: string, buildingId: string): Promise<boolean> {
  const direct = await prisma.userResourceRole.findFirst({
    where: { userId, scopeType: 'BUILDING', buildingId, role: 'BUILDING_ADMIN' },
  })
  if (direct) return true
  const via = await prisma.groupResourceRole.findFirst({
    where: {
      scopeType: 'BUILDING',
      buildingId,
      role: 'BUILDING_ADMIN',
      group: { members: { some: { userId } } },
    },
  })
  return !!via
}

/**
 * Returns all buildingIds on which the user has BUILDING_ADMIN access,
 * combining direct UserResourceRole rows and GroupResourceRole memberships.
 */
export async function getManagedBuildingIds(userId: string): Promise<string[]> {
  const [direct, via] = await Promise.all([
    prisma.userResourceRole.findMany({
      where: { userId, scopeType: 'BUILDING', role: 'BUILDING_ADMIN' },
      select: { buildingId: true },
    }),
    prisma.groupResourceRole.findMany({
      where: {
        scopeType: 'BUILDING',
        role: 'BUILDING_ADMIN',
        group: { members: { some: { userId } } },
      },
      select: { buildingId: true },
    }),
  ])
  const ids = [
    ...(direct.map((r) => r.buildingId).filter(Boolean) as string[]),
    ...(via.map((r) => r.buildingId).filter(Boolean) as string[]),
  ]
  return [...new Set(ids)]
}

/**
 * Returns true if the user holds FLOOR_MANAGER access on the given floor,
 * either via a direct UserResourceRole or through a GroupResourceRole.
 * Building admins inherit floor manager permissions for all floors in their building.
 */
export async function isFloorManagerForFloor(userId: string, floorId: string): Promise<boolean> {
  const direct = await prisma.userResourceRole.findFirst({
    where: { userId, scopeType: 'FLOOR', floorId, role: 'FLOOR_MANAGER' },
  })
  if (direct) return true
  const via = await prisma.groupResourceRole.findFirst({
    where: {
      scopeType: 'FLOOR',
      floorId,
      role: 'FLOOR_MANAGER',
      group: { members: { some: { userId } } },
    },
  })
  if (via) return true

  // Building admins inherit floor manager permissions
  const floor = await prisma.floor.findUnique({ where: { id: floorId }, select: { buildingId: true } })
  if (!floor) return false
  return isBuildingManagerForBuilding(userId, floor.buildingId)
}

/**
 * Returns all floorIds on which the user has FLOOR_MANAGER access,
 * combining direct UserResourceRole rows, GroupResourceRole memberships,
 * and inherited access from BUILDING_ADMIN roles.
 */
export async function getManagedFloorIds(userId: string): Promise<string[]> {
  const [direct, via, managedBuildingIds] = await Promise.all([
    prisma.userResourceRole.findMany({
      where: { userId, scopeType: 'FLOOR', role: 'FLOOR_MANAGER' },
      select: { floorId: true },
    }),
    prisma.groupResourceRole.findMany({
      where: {
        scopeType: 'FLOOR',
        role: 'FLOOR_MANAGER',
        group: { members: { some: { userId } } },
      },
      select: { floorId: true },
    }),
    getManagedBuildingIds(userId),
  ])

  const ids = [
    ...(direct.map((r) => r.floorId).filter(Boolean) as string[]),
    ...(via.map((r) => r.floorId).filter(Boolean) as string[]),
  ]

  // Inherit all floors from managed buildings
  if (managedBuildingIds.length > 0) {
    const inheritedFloors = await prisma.floor.findMany({
      where: { buildingId: { in: managedBuildingIds } },
      select: { id: true },
    })
    ids.push(...inheritedFloors.map((f) => f.id))
  }

  return [...new Set(ids)]
}

// Middleware for asset endpoints: resolves asset → floorId directly, then checks floor-level role.
// Also passes for SUPER_ADMIN.
export function requireFloorRoleForAsset(minimumRole: ResourceRoleType) {
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
    const asset = await prisma.asset.findUnique({
      where: { id },
      select: { floorId: true },
    })

    if (!asset) {
      return reply.status(404).send({ error: { message: 'Asset not found', code: 'NOT_FOUND' } })
    }

    if (!asset.floorId) {
      return reply.status(403).send({
        error: { message: 'Insufficient permissions', code: 'FORBIDDEN' },
      })
    }

    const floorId = asset.floorId

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
      // Check if user is a building admin for this floor's building (inherits floor manager)
      const isBuildingAdmin = await isFloorManagerForFloor(request.user.id, floorId)
      if (!isBuildingAdmin) {
        return reply.status(403).send({
          error: { message: 'Insufficient permissions', code: 'FORBIDDEN' },
        })
      }
      return
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
