import type { FastifyInstance } from 'fastify'
import { prisma } from '../lib/prisma.js'
import { GlobalRole, NotificationType } from '@roomer/shared'
import { requireAuth } from '../middleware/requireAuth.js'
import { isBuildingManagerForBuilding, isFloorManagerForFloor, getManagedBuildingIds, getBuildingAdminUserIds } from '../middleware/requireRole.js'
import { enqueueNotification } from '../lib/queue.js'
import { dispatchWebhook } from '../lib/webhook.js'
import { recordAuditLog } from '../lib/audit.js'
import { resolveBuildingTimezone } from '../lib/timezone.js'
import { z } from 'zod'

// How long an unactioned request stays open before the expire-manager-requests
// cron worker (lib/queue.ts) auto-closes it. Fixed rather than org-configurable
// — this is a low-effort, low-stakes feature (see #85); a per-org setting can
// be added later if anyone actually needs to tune it.
export const MANAGER_REQUEST_EXPIRY_DAYS = 14

// Serialises the check-then-insert below per (userId, floorId) so two
// near-simultaneous submits (a double-click, a retried request) can't both
// pass the "no existing PENDING request" check before either commits —
// FloorManagerRequest has no unique constraint to catch this at the DB
// level. Distinct integer from every other pg_advisory_xact_lock class in
// this codebase (4242-4246 are taken — see lib/booking.ts, lib/queue.ts,
// lib/group-mapping.ts).
const MANAGER_REQUEST_LOCK_CLASS = 4247

const createRequestSchema = z.object({
  floorId: z.string().min(1),
  note: z.string().max(1000).optional(),
})

const reviewRequestSchema = z.object({
  reviewNote: z.string().max(1000).optional(),
})

// Same resolvedTimezone convention as every other list endpoint in this
// codebase (bookings.ts, queue.ts, ballots.ts) — without it, createdAt/
// expiresAt/reviewedAt on this page rendered in the reviewer's own browser
// timezone rather than the floor's building, unlike the structurally
// identical booking-approvals page.
async function withResolvedTimezone<T extends { floor: { building: { id: string } } }>(requests: T[]): Promise<Array<T & { resolvedTimezone: string }>> {
  const tzCache = new Map<string, Promise<string>>()
  const resolveTz = (buildingId: string) => {
    if (!tzCache.has(buildingId)) tzCache.set(buildingId, resolveBuildingTimezone(prisma, buildingId))
    return tzCache.get(buildingId)!
  }
  return Promise.all(requests.map(async (r) => ({ ...r, resolvedTimezone: await resolveTz(r.floor.building.id) })))
}

/** SUPER_ADMIN, or a BUILDING_ADMIN for the given building. */
async function canReview(userId: string, globalRole: string, buildingId: string): Promise<boolean> {
  if (globalRole === GlobalRole.SUPER_ADMIN) return true
  return isBuildingManagerForBuilding(userId, buildingId)
}

export async function managerRequestRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.addHook('onRoute', (route) => { route.schema = { tags: ['Manager Requests'], ...route.schema } })

  // POST /manager-requests — request floor manager access to a floor
  fastify.post('/', { preHandler: [requireAuth] }, async (request, reply) => {
    const result = createRequestSchema.safeParse(request.body)
    if (!result.success) {
      return reply.status(400).send({
        error: { message: 'Validation failed', code: 'VALIDATION_ERROR', details: result.error.flatten() },
      })
    }
    const { floorId, note } = result.data

    const floor = await prisma.floor.findUnique({
      where: { id: floorId },
      include: { building: { select: { id: true, name: true } } },
    })
    if (!floor) return reply.status(404).send({ error: { message: 'Floor not found', code: 'NOT_FOUND' } })

    if (await isFloorManagerForFloor(request.user.id, floorId)) {
      return reply.status(409).send({ error: { message: 'You are already a floor manager for this floor', code: 'ALREADY_MANAGER' } })
    }

    const expiresAt = new Date(Date.now() + MANAGER_REQUEST_EXPIRY_DAYS * 24 * 3600 * 1000)
    const created = await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(${MANAGER_REQUEST_LOCK_CLASS}, hashtext(${request.user.id} || ':' || ${floorId}))`

      const existing = await tx.floorManagerRequest.findFirst({
        where: { userId: request.user.id, floorId, status: 'PENDING' },
      })
      if (existing) {
        throw Object.assign(new Error('ALREADY_PENDING'), { code: 'ALREADY_PENDING' })
      }

      const req = await tx.floorManagerRequest.create({
        data: { userId: request.user.id, floorId, note: note ?? null, expiresAt },
      })
      await recordAuditLog(tx, {
        actorId: request.user.id,
        action: 'floor_manager_request.created',
        resourceType: 'FloorManagerRequest',
        resourceId: req.id,
        after: { userId: request.user.id, floorId, note: req.note },
        ipAddress: request.ip,
      }, request.log)
      return req
    }).catch((err) => {
      if ((err as { code?: string }).code === 'ALREADY_PENDING') return null
      throw err
    })
    if (!created) {
      return reply.status(409).send({ error: { message: 'You already have a pending request for this floor', code: 'ALREADY_PENDING' } })
    }

    const approverIds = new Set<string>(await getBuildingAdminUserIds(floor.building.id))
    const superAdmins = await prisma.user.findMany({
      where: { globalRole: GlobalRole.SUPER_ADMIN, accountStatus: 'ACTIVE' },
      select: { id: true },
    })
    for (const a of superAdmins) approverIds.add(a.id)
    // Don't notify the requester about their own request, in the unlikely
    // case they're also a building admin/super admin for this floor's building.
    approverIds.delete(request.user.id)

    for (const approverId of approverIds) {
      await enqueueNotification({ type: NotificationType.MANAGER_REQUEST_SUBMITTED, userId: approverId, managerRequestId: created.id })
    }
    dispatchWebhook('manager_request.submitted', { id: created.id, userId: request.user.id, floorId, buildingId: floor.building.id }).catch(() => {})

    return reply.status(201).send({ data: created })
  })

  // GET /manager-requests/mine — the caller's own request history
  fastify.get('/mine', { preHandler: [requireAuth] }, async (request, reply) => {
    const requests = await prisma.floorManagerRequest.findMany({
      where: { userId: request.user.id },
      orderBy: { createdAt: 'desc' },
      include: {
        floor: { select: { id: true, name: true, building: { select: { id: true, name: true } } } },
        reviewedBy: { select: { id: true, displayName: true } },
      },
    })
    return reply.status(200).send({ data: await withResolvedTimezone(requests) })
  })

  // GET /manager-requests — admin dashboard: SUPER_ADMIN sees every request,
  // a BUILDING_ADMIN sees only requests for floors in buildings they manage.
  // Neither role → forbidden, same as every other admin-listing endpoint.
  fastify.get('/', { preHandler: [requireAuth] }, async (request, reply) => {
    const isSuperAdmin = request.user.globalRole === GlobalRole.SUPER_ADMIN
    let buildingIds: string[] | null = null
    if (!isSuperAdmin) {
      buildingIds = await getManagedBuildingIds(request.user.id)
      if (buildingIds.length === 0) {
        return reply.status(403).send({ error: { message: 'Insufficient permissions', code: 'FORBIDDEN' } })
      }
    }

    const statusParam = (request.query as { status?: string }).status
    const status = statusParam && statusParam !== 'all' ? (statusParam as 'PENDING' | 'APPROVED' | 'REJECTED' | 'CANCELLED' | 'EXPIRED') : undefined

    const requests = await prisma.floorManagerRequest.findMany({
      where: {
        ...(status ? { status } : {}),
        ...(buildingIds ? { floor: { buildingId: { in: buildingIds } } } : {}),
      },
      orderBy: { createdAt: 'desc' },
      include: {
        user: { select: { id: true, displayName: true, email: true } },
        floor: { select: { id: true, name: true, building: { select: { id: true, name: true } } } },
        reviewedBy: { select: { id: true, displayName: true } },
      },
    })
    return reply.status(200).send({ data: await withResolvedTimezone(requests) })
  })

  // POST /manager-requests/:id/approve
  fastify.post('/:id/approve', { preHandler: [requireAuth] }, async (request, reply) => {
    const { id } = request.params as { id: string }
    const req = await prisma.floorManagerRequest.findUnique({
      where: { id },
      include: { floor: { include: { building: { select: { id: true, name: true } } } }, user: true },
    })
    if (!req) return reply.status(404).send({ error: { message: 'Request not found', code: 'NOT_FOUND' } })
    if (!(await canReview(request.user.id, request.user.globalRole, req.floor.buildingId))) {
      return reply.status(403).send({ error: { message: 'Insufficient permissions', code: 'FORBIDDEN' } })
    }
    if (req.status !== 'PENDING') {
      return reply.status(409).send({ error: { message: 'This request is no longer pending', code: 'NOT_PENDING' } })
    }

    try {
      await prisma.$transaction(async (tx) => {
        // Claim atomically on the same condition just checked above —
        // without this, a concurrent reject/cancel/expiry-cron pass reading
        // PENDING before this transaction commits can unconditionally
        // overwrite this request's status afterward, leaving the record
        // showing REJECTED/CANCELLED/EXPIRED while the FLOOR_MANAGER role
        // this transaction is about to create stays granted regardless — the
        // record and the actual access grant fall out of sync with nothing
        // to reconcile them. Every structurally identical PENDING-request
        // lifecycle elsewhere in this codebase (queue claims, transfers,
        // swaps, the expiry cron below) already claims this way; this route
        // just hadn't been brought in line with it.
        const claimed = await tx.floorManagerRequest.updateMany({
          where: { id, status: 'PENDING' },
          data: { status: 'APPROVED', reviewedById: request.user.id, reviewedAt: new Date() },
        })
        if (claimed.count === 0) {
          throw Object.assign(new Error('NOT_PENDING'), { code: 'NOT_PENDING' })
        }
        const role = await tx.userResourceRole.create({
          data: { userId: req.userId, role: 'FLOOR_MANAGER', scopeType: 'FLOOR', floorId: req.floorId },
        })
        await recordAuditLog(tx, {
          actorId: request.user.id,
          action: 'floor_manager_request.approved',
          resourceType: 'FloorManagerRequest',
          resourceId: id,
          before: { status: 'PENDING' },
          after: { status: 'APPROVED', reviewedById: request.user.id },
          ipAddress: request.ip,
        }, request.log)
        await recordAuditLog(tx, {
          actorId: request.user.id,
          action: 'user_resource_role.granted',
          resourceType: 'UserResourceRole',
          resourceId: role.id,
          after: { userId: req.userId, role: 'FLOOR_MANAGER', scopeType: 'FLOOR', floorId: req.floorId },
          ipAddress: request.ip,
        }, request.log)
      })
    } catch (err) {
      if ((err as { code?: string }).code === 'NOT_PENDING') {
        return reply.status(409).send({ error: { message: 'This request is no longer pending', code: 'NOT_PENDING' } })
      }
      // Unique constraint on UserResourceRole — the user picked up the same
      // FLOOR_MANAGER grant some other way (direct admin assignment, a group
      // role) between the request being created and this approval. The
      // request itself should still resolve as approved rather than error.
      // Re-claims the same way (status: 'PENDING' guard) rather than an
      // unconditional update, for the same reason as above.
      if ((err as { code?: string }).code === 'P2002') {
        const claimed = await prisma.floorManagerRequest.updateMany({
          where: { id, status: 'PENDING' },
          data: { status: 'APPROVED', reviewedById: request.user.id, reviewedAt: new Date() },
        })
        if (claimed.count === 0) {
          return reply.status(409).send({ error: { message: 'This request is no longer pending', code: 'NOT_PENDING' } })
        }
        await recordAuditLog(prisma, {
          actorId: request.user.id,
          action: 'floor_manager_request.approved',
          resourceType: 'FloorManagerRequest',
          resourceId: id,
          before: { status: 'PENDING' },
          after: { status: 'APPROVED', reviewedById: request.user.id },
          ipAddress: request.ip,
        }, request.log)
      } else {
        throw err
      }
    }

    await enqueueNotification({ type: NotificationType.MANAGER_REQUEST_APPROVED, userId: req.userId, managerRequestId: req.id })
    dispatchWebhook('manager_request.approved', { id: req.id, userId: req.userId, floorId: req.floorId, reviewedById: request.user.id }).catch(() => {})

    return reply.status(200).send({ data: { ok: true } })
  })

  // POST /manager-requests/:id/reject
  fastify.post('/:id/reject', { preHandler: [requireAuth] }, async (request, reply) => {
    const { id } = request.params as { id: string }
    const result = reviewRequestSchema.safeParse(request.body ?? {})
    if (!result.success) {
      return reply.status(400).send({
        error: { message: 'Validation failed', code: 'VALIDATION_ERROR', details: result.error.flatten() },
      })
    }

    const req = await prisma.floorManagerRequest.findUnique({
      where: { id },
      include: { floor: { select: { buildingId: true } } },
    })
    if (!req) return reply.status(404).send({ error: { message: 'Request not found', code: 'NOT_FOUND' } })
    if (!(await canReview(request.user.id, request.user.globalRole, req.floor.buildingId))) {
      return reply.status(403).send({ error: { message: 'Insufficient permissions', code: 'FORBIDDEN' } })
    }
    if (req.status !== 'PENDING') {
      return reply.status(409).send({ error: { message: 'This request is no longer pending', code: 'NOT_PENDING' } })
    }

    // Claimed atomically (status: 'PENDING' guard), not an unconditional
    // update — otherwise this can race a concurrent approve (or the expiry
    // cron) that read PENDING first and overwrite its result: the request
    // would show REJECTED here while the other path's FLOOR_MANAGER grant
    // (or EXPIRED status) still stands, with nothing to reconcile the two.
    const claimed = await prisma.floorManagerRequest.updateMany({
      where: { id, status: 'PENDING' },
      data: { status: 'REJECTED', reviewedById: request.user.id, reviewedAt: new Date(), reviewNote: result.data.reviewNote ?? null },
    })
    if (claimed.count === 0) {
      return reply.status(409).send({ error: { message: 'This request is no longer pending', code: 'NOT_PENDING' } })
    }
    await recordAuditLog(prisma, {
      actorId: request.user.id,
      action: 'floor_manager_request.rejected',
      resourceType: 'FloorManagerRequest',
      resourceId: id,
      before: { status: 'PENDING' },
      after: { status: 'REJECTED', reviewedById: request.user.id, reviewNote: result.data.reviewNote ?? null },
      ipAddress: request.ip,
    }, request.log)

    await enqueueNotification({ type: NotificationType.MANAGER_REQUEST_REJECTED, userId: req.userId, managerRequestId: req.id })
    dispatchWebhook('manager_request.rejected', { id: req.id, userId: req.userId, floorId: req.floorId, reviewedById: request.user.id }).catch(() => {})

    return reply.status(200).send({ data: { ok: true } })
  })

  // DELETE /manager-requests/:id — requester withdraws their own still-pending request
  fastify.delete('/:id', { preHandler: [requireAuth] }, async (request, reply) => {
    const { id } = request.params as { id: string }
    const req = await prisma.floorManagerRequest.findUnique({ where: { id } })
    if (!req) return reply.status(404).send({ error: { message: 'Request not found', code: 'NOT_FOUND' } })
    if (req.userId !== request.user.id) {
      return reply.status(403).send({ error: { message: 'Forbidden', code: 'FORBIDDEN' } })
    }
    if (req.status !== 'PENDING') {
      return reply.status(409).send({ error: { message: 'This request is no longer pending', code: 'NOT_PENDING' } })
    }
    // Claimed atomically (status: 'PENDING' guard) — otherwise a self-cancel
    // can race a concurrent approve and overwrite an already-APPROVED row
    // back to CANCELLED while the FLOOR_MANAGER grant that approve created
    // stays in place, same class of bug as approve/reject above.
    const claimed = await prisma.floorManagerRequest.updateMany({
      where: { id, status: 'PENDING' },
      data: { status: 'CANCELLED' },
    })
    if (claimed.count === 0) {
      return reply.status(409).send({ error: { message: 'This request is no longer pending', code: 'NOT_PENDING' } })
    }
    await recordAuditLog(prisma, {
      actorId: request.user.id,
      action: 'floor_manager_request.cancelled',
      resourceType: 'FloorManagerRequest',
      resourceId: id,
      before: { status: 'PENDING' },
      after: { status: 'CANCELLED' },
      ipAddress: request.ip,
    }, request.log)
    return reply.status(200).send({ data: { ok: true } })
  })
}
