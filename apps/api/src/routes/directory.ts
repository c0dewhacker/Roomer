import type { FastifyInstance } from 'fastify'
import type { User } from '@prisma/client'
import { prisma } from '../lib/prisma.js'
import { GlobalRole } from '@roomer/shared'
import { requireAuth } from '../middleware/requireAuth.js'
import { z } from 'zod'

const querySchema = z.object({
  search: z.string().trim().max(255).optional(),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'date must be YYYY-MM-DD').optional(),
  buildingId: z.string().min(1).optional(),
  floorId: z.string().min(1).optional(),
})

const PER_QUERY_CAP = 500

/**
 * Building IDs the user is allowed to see occupancy for.
 * Returns 'ALL' for super admins. For everyone else: open buildings (no access
 * rules) plus buildings their groups can access — mirrors canUserAccessBuilding
 * but resolved in a few set queries rather than one-per-building.
 */
async function accessibleBuildingIds(user: Pick<User, 'id' | 'globalRole'>): Promise<string[] | 'ALL'> {
  if (user.globalRole === GlobalRole.SUPER_ADMIN) return 'ALL'

  const [buildings, restricted, memberships] = await Promise.all([
    prisma.building.findMany({ select: { id: true } }),
    prisma.groupBuildingAccess.findMany({ select: { buildingId: true, groupId: true } }),
    prisma.userGroupMember.findMany({ where: { userId: user.id }, select: { groupId: true } }),
  ])

  const userGroupIds = new Set(memberships.map((m) => m.groupId))
  const restrictedBy = new Map<string, Set<string>>()
  for (const r of restricted) {
    let set = restrictedBy.get(r.buildingId)
    if (!set) { set = new Set(); restrictedBy.set(r.buildingId, set) }
    set.add(r.groupId)
  }

  return buildings
    .filter((b) => {
      const groups = restrictedBy.get(b.id)
      if (!groups || groups.size === 0) return true // open building
      for (const g of userGroupIds) if (groups.has(g)) return true
      return false
    })
    .map((b) => b.id)
}

const assetLocationSelect = {
  id: true,
  name: true,
  primaryZone: { select: { id: true, name: true } },
  floor: { select: { id: true, name: true, building: { select: { id: true, name: true } } } },
} as const

type AssetLocation = {
  id: string
  name: string
  primaryZone: { id: string; name: string } | null
  floor: { id: string; name: string; building: { id: string; name: string } } | null
}

function locationOf(asset: AssetLocation) {
  return {
    assetId: asset.id,
    assetName: asset.name,
    zoneId: asset.primaryZone?.id ?? null,
    zoneName: asset.primaryZone?.name ?? null,
    floorId: asset.floor?.id ?? null,
    floorName: asset.floor?.name ?? null,
    buildingId: asset.floor?.building?.id ?? null,
    buildingName: asset.floor?.building?.name ?? null,
  }
}

export async function directoryRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.addHook('onRoute', (route) => { route.schema = { tags: ['Directory'], ...route.schema } })

  // GET /directory/whereabouts — locate people across accessible buildings.
  //   - no search: everyone with a CONFIRMED booking on the date ("who's in"),
  //     plus their home desk as context.
  //   - with search: anyone matching name/email who has a booking that day OR a
  //     permanent desk assignment (wayfinder — works even if they didn't book).
  fastify.get('/whereabouts', { preHandler: [requireAuth] }, async (request, reply) => {
    const parsed = querySchema.safeParse(request.query)
    if (!parsed.success) {
      return reply.status(400).send({ error: { message: 'Invalid query parameters', code: 'VALIDATION_ERROR', details: parsed.error.flatten() } })
    }
    const search = parsed.data.search && parsed.data.search.length > 0 ? parsed.data.search : undefined
    const dateStr = parsed.data.date ?? new Date().toISOString().slice(0, 10)
    const dayStart = new Date(`${dateStr}T00:00:00.000Z`)
    const dayEnd = new Date(dayStart.getTime() + 24 * 60 * 60 * 1000)

    const accessible = await accessibleBuildingIds(request.user)
    if (accessible !== 'ALL' && accessible.length === 0) {
      return reply.status(200).send({ data: [], meta: { total: 0, date: dateStr } })
    }

    // Building/floor scoping: explicit filters narrow further, but cannot widen
    // beyond what the requester may access.
    const buildingScope = accessible === 'ALL' ? undefined : { buildingId: { in: accessible } }
    const floorWhere: Record<string, unknown> = { ...(buildingScope ?? {}) }
    if (parsed.data.floorId) floorWhere.id = parsed.data.floorId
    if (parsed.data.buildingId) {
      if (accessible !== 'ALL' && !accessible.includes(parsed.data.buildingId)) {
        return reply.status(403).send({ error: { message: 'Building not accessible', code: 'FORBIDDEN' } })
      }
      floorWhere.buildingId = parsed.data.buildingId
    }
    const assetWhere = { floor: Object.keys(floorWhere).length ? floorWhere : undefined }

    // Visibility: opted-out users are hidden from everyone but themselves.
    const visibility = { OR: [{ visibleInColleagueSearch: true }, { id: request.user.id }] }
    const userWhere = search
      ? { AND: [visibility, { OR: [
          { displayName: { contains: search, mode: 'insensitive' as const } },
          { email: { contains: search, mode: 'insensitive' as const } },
        ] }] }
      : visibility

    const bookings = await prisma.booking.findMany({
      where: {
        status: 'CONFIRMED',
        startsAt: { lt: dayEnd },
        endsAt: { gt: dayStart },
        asset: assetWhere,
        user: userWhere,
      },
      select: {
        startsAt: true, endsAt: true,
        user: { select: { id: true, displayName: true, email: true } },
        asset: { select: assetLocationSelect },
      },
      take: PER_QUERY_CAP,
    })

    const bookedUserIds = [...new Set(bookings.map((b) => b.user.id))]

    // Assignments: when searching, return all matched users' home desks (even if
    // they have no booking). Otherwise only the booked users' desks, as context.
    const assignments = (search || bookedUserIds.length > 0)
      ? await prisma.assetUserAssignment.findMany({
          where: {
            asset: assetWhere,
            user: userWhere,
            ...(search ? {} : { userId: { in: bookedUserIds } }),
          },
          select: {
            isPrimary: true,
            user: { select: { id: true, displayName: true, email: true } },
            asset: { select: assetLocationSelect },
          },
          take: PER_QUERY_CAP,
        })
      : []

    // Group by user
    type Person = {
      user: { id: string; displayName: string; email: string }
      today: ReturnType<typeof locationOf>[]
      assignedDesks: (ReturnType<typeof locationOf> & { isPrimary: boolean })[]
    }
    const people = new Map<string, Person>()
    const ensure = (u: { id: string; displayName: string; email: string }): Person => {
      let p = people.get(u.id)
      if (!p) { p = { user: u, today: [], assignedDesks: [] }; people.set(u.id, p) }
      return p
    }

    for (const b of bookings) {
      ensure(b.user).today.push(locationOf(b.asset))
    }
    for (const a of assignments) {
      ensure(a.user).assignedDesks.push({ ...locationOf(a.asset), isPrimary: a.isPrimary })
    }

    const data = [...people.values()].sort((a, b) => a.user.displayName.localeCompare(b.user.displayName))

    return reply.status(200).send({ data, meta: { total: data.length, date: dateStr } })
  })
}
