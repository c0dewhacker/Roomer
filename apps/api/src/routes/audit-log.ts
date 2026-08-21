import type { FastifyInstance } from 'fastify'
import type { Prisma } from '@prisma/client'
import { prisma } from '../lib/prisma.js'
import { GlobalRole } from '@roomer/shared'
import { requireAuth } from '../middleware/requireAuth.js'
import { requireGlobalRole } from '../middleware/requireRole.js'
import { wantsCsv, sendCsv } from '../lib/csv.js'
import { z } from 'zod'

// CSV export has no page/limit cap (same "everything matching the filter"
// contract as the analytics CSV exports), but is capped here to avoid an
// unbounded query against a table with no natural upper bound.
const CSV_EXPORT_LIMIT = 10_000

const auditLogQuerySchema = z.object({
  actorId: z.string().min(1).optional(),
  resourceType: z.string().min(1).optional(),
  resourceId: z.string().min(1).optional(),
  action: z.string().min(1).optional(),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(100).default(20),
})

export async function auditLogRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.addHook('onRoute', (route) => { route.schema = { tags: ['Audit Log'], ...route.schema } })

  // GET /audit-log — SUPER_ADMIN only. This is a compliance/security record
  // spanning every resource type in the app, not scoped to a single
  // building/floor the way most other admin listings are — no
  // building-admin-scoped variant yet (see #234).
  fastify.get('/', { preHandler: [requireAuth, requireGlobalRole(GlobalRole.SUPER_ADMIN)] }, async (request, reply) => {
    const result = auditLogQuerySchema.safeParse(request.query)
    if (!result.success) {
      return reply.status(400).send({
        error: { message: 'Invalid query parameters', code: 'VALIDATION_ERROR', details: result.error.flatten() },
      })
    }

    const { actorId, resourceType, resourceId, action, from, to, page, limit } = result.data
    const where: Prisma.AuditLogWhereInput = {
      ...(actorId && { actorId }),
      ...(resourceType && { resourceType }),
      ...(resourceId && { resourceId }),
      ...(action && { action }),
      ...((from || to) && {
        createdAt: {
          ...(from && { gte: new Date(from) }),
          ...(to && { lte: new Date(to) }),
        },
      }),
    }

    if (wantsCsv(request)) {
      const rows = await prisma.auditLog.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take: CSV_EXPORT_LIMIT,
        include: { actor: { select: { displayName: true, email: true } } },
      })
      return sendCsv(
        reply,
        `audit-log-${Date.now()}.csv`,
        ['Timestamp', 'Actor', 'Actor Email', 'Action', 'Resource Type', 'Resource ID', 'IP Address', 'Before', 'After'],
        rows.map((r) => [
          r.createdAt.toISOString(),
          r.actor?.displayName ?? 'System',
          r.actor?.email ?? '',
          r.action,
          r.resourceType,
          r.resourceId,
          r.ipAddress ?? '',
          r.before ? JSON.stringify(r.before) : '',
          r.after ? JSON.stringify(r.after) : '',
        ]),
      )
    }

    const skip = (page - 1) * limit
    const [data, total] = await Promise.all([
      prisma.auditLog.findMany({
        where,
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' },
        include: { actor: { select: { id: true, displayName: true, email: true } } },
      }),
      prisma.auditLog.count({ where }),
    ])

    return reply.status(200).send({
      data,
      meta: { page, limit, total, totalPages: Math.ceil(total / limit) },
    })
  })
}
