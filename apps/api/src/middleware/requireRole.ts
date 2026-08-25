import type { FastifyRequest, FastifyReply } from 'fastify'
import { GlobalRole } from '@roomer/shared'
import { prisma } from '../lib/prisma.js'

/**
 * Serialises grant of a UserResourceRole/GroupResourceRole for a given
 * (subject, scope) pair. Both models' unique constraints are
 * (subjectId, scopeType, buildingId, floorId) with buildingId/floorId
 * nullable — exactly one is ever set per row, so Postgres's NULL<>NULL
 * uniqueness semantics mean that constraint never actually fires for
 * either scope. Without this lock, two concurrent grant requests for the
 * same subject+scope both pass their pre-check (findFirst) before either
 * commits, creating duplicate rows — and since the corresponding revoke
 * endpoints used to delete only the one row they were given, an admin's
 * "remove access" action left the other duplicate (and therefore the
 * access) silently in place. Distinct integer from every other
 * pg_advisory_xact_lock class in this codebase (4242-4248 are taken —
 * note 4247 is currently reused by three unrelated call sites, a
 * pre-existing naming collision this doesn't need to fix to be correct,
 * since none of them lock this same key).
 */
export const RESOURCE_ROLE_GRANT_LOCK_CLASS = 4249

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
 * Returns the userIds of everyone who holds BUILDING_ADMIN access on the
 * given building — the inverse of getManagedBuildingIds. Used to notify the
 * right people about something building-scoped (e.g. a floor manager access
 * request) without needing a separate per-admin loop over every building.
 */
export async function getBuildingAdminUserIds(buildingId: string): Promise<string[]> {
  const [direct, via] = await Promise.all([
    prisma.userResourceRole.findMany({
      where: { scopeType: 'BUILDING', buildingId, role: 'BUILDING_ADMIN' },
      select: { userId: true },
    }),
    prisma.groupResourceRole.findMany({
      where: { scopeType: 'BUILDING', buildingId, role: 'BUILDING_ADMIN' },
      select: { group: { select: { members: { select: { userId: true } } } } },
    }),
  ])
  const ids = [
    ...direct.map((r) => r.userId),
    ...via.flatMap((r) => r.group.members.map((m) => m.userId)),
  ]
  return [...new Set(ids)]
}

/**
 * Returns true if the user holds FLOOR_MANAGER access on the given floor,
 * either via a direct UserResourceRole or through a GroupResourceRole.
 * Building admins inherit floor manager permissions for all floors in their building.
 */
export async function isFloorManagerForFloor(userId: string, floorId: string): Promise<boolean> {
  // Run direct and group role checks in parallel — both are independent
  const [direct, via] = await Promise.all([
    prisma.userResourceRole.findFirst({
      where: { userId, scopeType: 'FLOOR', floorId, role: 'FLOOR_MANAGER' },
    }),
    prisma.groupResourceRole.findFirst({
      where: {
        scopeType: 'FLOOR',
        floorId,
        role: 'FLOOR_MANAGER',
        group: { members: { some: { userId } } },
      },
    }),
  ])
  if (direct || via) return true

  // Building admins inherit floor manager permissions
  const floor = await prisma.floor.findUnique({ where: { id: floorId }, select: { buildingId: true } })
  if (!floor) return false
  return isBuildingManagerForBuilding(userId, floor.buildingId)
}

/**
 * Returns the userIds of everyone who holds FLOOR_MANAGER access on the given
 * floor — the inverse of isFloorManagerForFloor. Deliberately does NOT also
 * include inherited building admins (unlike isFloorManagerForFloor's access
 * check) — callers that want the full approver audience combine this with
 * getBuildingAdminUserIds separately, so inheriting here would just produce
 * duplicate ids that get deduped anyway, at the cost of an extra building
 * lookup this function doesn't otherwise need.
 */
export async function getFloorManagerUserIds(floorId: string): Promise<string[]> {
  const [direct, via] = await Promise.all([
    prisma.userResourceRole.findMany({
      where: { scopeType: 'FLOOR', floorId, role: 'FLOOR_MANAGER' },
      select: { userId: true },
    }),
    prisma.groupResourceRole.findMany({
      where: { scopeType: 'FLOOR', floorId, role: 'FLOOR_MANAGER' },
      select: { group: { select: { members: { select: { userId: true } } } } },
    }),
  ])
  const ids = [
    ...direct.map((r) => r.userId),
    ...via.flatMap((r) => r.group.members.map((m) => m.userId)),
  ]
  return [...new Set(ids)]
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

