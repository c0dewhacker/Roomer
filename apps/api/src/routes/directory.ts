import type { FastifyInstance } from 'fastify'
import type { User } from '@prisma/client'
import { prisma } from '../lib/prisma.js'
import { GlobalRole } from '@roomer/shared'
import { requireAuth } from '../middleware/requireAuth.js'
import { zonedWallClockToUtc } from '../lib/timezone.js'
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

/**
 * Floor IDs the user is allowed to see occupancy for — the floor-level
 * counterpart to accessibleBuildingIds (GroupFloorAccess vs
 * GroupBuildingAccess). checkGroupAccess treats building and floor
 * restrictions as independent gates that must BOTH pass; this endpoint
 * previously only applied the building gate, so a floor restricted via
 * GroupFloorAccess inside an otherwise-open building leaked who was booked
 * there and their home-desk assignments to anyone.
 */
async function accessibleFloorIds(user: Pick<User, 'id' | 'globalRole'>): Promise<string[] | 'ALL'> {
  if (user.globalRole === GlobalRole.SUPER_ADMIN) return 'ALL'

  const [floors, restricted, memberships] = await Promise.all([
    prisma.floor.findMany({ select: { id: true } }),
    prisma.groupFloorAccess.findMany({ select: { floorId: true, groupId: true } }),
    prisma.userGroupMember.findMany({ where: { userId: user.id }, select: { groupId: true } }),
  ])

  const userGroupIds = new Set(memberships.map((m) => m.groupId))
  const restrictedBy = new Map<string, Set<string>>()
  for (const r of restricted) {
    let set = restrictedBy.get(r.floorId)
    if (!set) { set = new Set(); restrictedBy.set(r.floorId, set) }
    set.add(r.groupId)
  }

  return floors
    .filter((f) => {
      const groups = restrictedBy.get(f.id)
      if (!groups || groups.size === 0) return true // open floor
      for (const g of userGroupIds) if (groups.has(g)) return true
      return false
    })
    .map((f) => f.id)
}

const assetLocationSelect = {
  id: true,
  name: true,
  primaryZone: { select: { id: true, name: true } },
  floor: { select: { id: true, name: true, building: { select: { id: true, name: true, timezone: true } } } },
} as const

type AssetLocation = {
  id: string
  name: string
  primaryZone: { id: string; name: string } | null
  floor: { id: string; name: string; building: { id: string; name: string; timezone: string | null } } | null
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
    buildingTimezone: asset.floor?.building?.timezone ?? null,
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
    const [year, month, day] = dateStr.split('-').map(Number)
    // Widened DB pre-filter only — "who's in on this date" spans buildings in
    // different timezones at once, so no single fixed UTC window can
    // correctly represent "today" for all of them simultaneously (unlike a
    // single-building calculation such as lease-expiry's calendarDaysUntil).
    // ±14h covers every real-world UTC offset; the precise per-building
    // local-day check happens per booking below, after each row's own
    // resolvedTimezone is known.
    const dayStartApprox = new Date(Date.UTC(year, month - 1, day) - 14 * 60 * 60 * 1000)
    const dayEndApprox = new Date(Date.UTC(year, month - 1, day) + 24 * 60 * 60 * 1000 + 14 * 60 * 60 * 1000)

    const [accessible, accessibleFloors, orgDefaultTimezone] = await Promise.all([
      accessibleBuildingIds(request.user),
      accessibleFloorIds(request.user),
      prisma.organisation.findFirst({ select: { defaultTimezone: true } }).then((o) => o?.defaultTimezone ?? 'UTC'),
    ])
    if (
      (accessible !== 'ALL' && accessible.length === 0) ||
      (accessibleFloors !== 'ALL' && accessibleFloors.length === 0)
    ) {
      return reply.status(200).send({ data: [], meta: { total: 0, date: dateStr } })
    }

    // Building/floor scoping: explicit filters narrow further, but cannot widen
    // beyond what the requester may access.
    const buildingScope = accessible === 'ALL' ? undefined : { buildingId: { in: accessible } }
    const floorWhere: Record<string, unknown> = { ...(buildingScope ?? {}) }
    if (accessibleFloors !== 'ALL') floorWhere.id = { in: accessibleFloors }
    if (parsed.data.floorId) {
      if (accessibleFloors !== 'ALL' && !accessibleFloors.includes(parsed.data.floorId)) {
        return reply.status(403).send({ error: { message: 'Floor not accessible', code: 'FORBIDDEN' } })
      }
      floorWhere.id = parsed.data.floorId
    }
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

    const bookingsCandidates = await prisma.booking.findMany({
      where: {
        status: 'CONFIRMED',
        startsAt: { lt: dayEndApprox },
        endsAt: { gt: dayStartApprox },
        asset: assetWhere,
        user: userWhere,
      },
      select: {
        startsAt: true, endsAt: true,
        user: { select: { id: true, displayName: true, email: true } },
        asset: { select: assetLocationSelect },
      },
      // Over-fetch relative to PER_QUERY_CAP since the ±14h DB window is
      // deliberately wider than any single building's actual local day —
      // trimmed back down to PER_QUERY_CAP after the precise per-booking
      // filter below.
      take: PER_QUERY_CAP * 2,
    })

    // Precise filter: does this booking overlap the REQUESTED calendar date
    // in ITS OWN building's timezone (same buildingTimezone ?? org-default
    // resolution order used for display below, so the filter and the
    // resolvedTimezone shown to the user always agree)? A fixed UTC window
    // alone can't do this correctly across buildings in different
    // timezones — see the ±14h DB pre-filter comment above for why.
    const bookings = bookingsCandidates
      .filter((b) => {
        const tz = b.asset.floor?.building?.timezone ?? orgDefaultTimezone
        const localDayStart = zonedWallClockToUtc(year, month, day, 0, 0, tz)
        const localDayEnd = new Date(localDayStart.getTime() + 24 * 60 * 60 * 1000)
        return b.startsAt < localDayEnd && b.endsAt > localDayStart
      })
      .slice(0, PER_QUERY_CAP)

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
      // startsAt/endsAt carried through so the frontend can label each entry —
      // without them, a person with two bookings the same day (a morning desk,
      // an afternoon meeting room; the app supports AM/PM/custom time-slot
      // bookings) rendered as two identical, unlabelled "Booked" rows with no
      // way to tell which one is current.
      today: (ReturnType<typeof locationOf> & { resolvedTimezone: string; startsAt: Date; endsAt: Date })[]
      assignedDesks: (ReturnType<typeof locationOf> & { isPrimary: boolean })[]
    }
    const people = new Map<string, Person>()
    const ensure = (u: { id: string; displayName: string; email: string }): Person => {
      let p = people.get(u.id)
      if (!p) { p = { user: u, today: [], assignedDesks: [] }; people.set(u.id, p) }
      return p
    }

    for (const b of bookings) {
      const location = locationOf(b.asset)
      ensure(b.user).today.push({
        ...location,
        resolvedTimezone: location.buildingTimezone ?? orgDefaultTimezone,
        startsAt: b.startsAt,
        endsAt: b.endsAt,
      })
    }
    for (const a of assignments) {
      ensure(a.user).assignedDesks.push({ ...locationOf(a.asset), isPrimary: a.isPrimary })
    }

    for (const p of people.values()) {
      p.today.sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime())
    }
    const data = [...people.values()].sort((a, b) => a.user.displayName.localeCompare(b.user.displayName))

    return reply.status(200).send({ data, meta: { total: data.length, date: dateStr } })
  })
}
