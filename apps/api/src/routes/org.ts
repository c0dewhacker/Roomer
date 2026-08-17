import type { FastifyInstance } from 'fastify'
import { prisma } from '../lib/prisma.js'
import { GlobalRole } from '@roomer/shared'
import { requireAuth } from '../middleware/requireAuth.js'
import { requireGlobalRole } from '../middleware/requireRole.js'

export async function orgRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.addHook('onRoute', (route) => { route.schema = { tags: ['Org'], ...route.schema } })

  // GET /org/hierarchy — the people manager-tree plus the department tree
  // *inferred* from manager links (dept A reports to dept B when A's people
  // mostly report to people in B). Powers the side-by-side hierarchy view.
  fastify.get('/hierarchy', { preHandler: [requireAuth, requireGlobalRole(GlobalRole.SUPER_ADMIN)] }, async (_request, reply) => {
    const [users, departments] = await Promise.all([
      prisma.user.findMany({
        where: { accountStatus: 'ACTIVE' },
        select: { id: true, displayName: true, email: true, departmentId: true, managerId: true },
        orderBy: { displayName: 'asc' },
      }),
      prisma.department.findMany({ select: { id: true, name: true }, orderBy: { name: 'asc' } }),
    ])

    const deptOf = new Map<string, string | null>()
    const memberCount = new Map<string, number>()
    const activeUserIds = new Set<string>()
    for (const u of users) {
      deptOf.set(u.id, u.departmentId)
      activeUserIds.add(u.id)
      if (u.departmentId) memberCount.set(u.departmentId, (memberCount.get(u.departmentId) ?? 0) + 1)
    }

    // Tally, per department, the departments its members report INTO (cross-dept only).
    const parentVotes = new Map<string, Map<string, number>>()
    for (const u of users) {
      if (!u.managerId || !u.departmentId) continue
      const mgrDept = deptOf.get(u.managerId) ?? null
      if (!mgrDept || mgrDept === u.departmentId) continue
      let votes = parentVotes.get(u.departmentId)
      if (!votes) { votes = new Map(); parentVotes.set(u.departmentId, votes) }
      votes.set(mgrDept, (votes.get(mgrDept) ?? 0) + 1)
    }

    const inferredParent = new Map<string, string>()
    for (const [deptId, votes] of parentVotes) {
      let best: string | null = null
      let bestN = 0
      for (const [parent, n] of votes) if (n > bestN) { best = parent; bestN = n }
      if (best) inferredParent.set(deptId, best)
    }

    return reply.status(200).send({
      data: {
        people: users.map((u) => ({
          id: u.id,
          displayName: u.displayName,
          email: u.email,
          departmentId: u.departmentId,
          managerId: u.managerId,
        })),
        departments: departments.map((d) => ({
          id: d.id,
          name: d.name,
          memberCount: memberCount.get(d.id) ?? 0,
          inferredParentId: inferredParent.get(d.id) ?? null,
        })),
        // Not just a null managerId — a manager who's been blocked/deactivated
        // is excluded from `users` above but their reports' managerId still
        // points at them, so those reports become top-level nodes in the
        // chart exactly the same as an unset manager (see OrgChartCanvas's
        // byId.has(n.parentId) check) and must count the same way here.
        unresolvedManagers: users.filter((u) => !u.managerId || !activeUserIds.has(u.managerId)).length,
      },
    })
  })
}
