import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { prisma } from '../lib/prisma.js'
import { createBallotSchema, updateBallotSchema, GlobalRole } from '@roomer/shared'
import { requireAuth } from '../middleware/requireAuth.js'
import { getManagedBuildingIds, getManagedFloorIds } from '../middleware/requireRole.js'
import { checkGroupAccess } from './groups.js'
import { ensureNextBallotRun, runDrawForRun, declineBallotEntry, resolveBallotAssetPool } from '../lib/ballot.js'
import { recordAuditLog } from '../lib/audit.js'
import { resolveBuildingTimezone } from '../lib/timezone.js'

/**
 * True when the caller may create/manage a ballot over this scope: SUPER_ADMIN,
 * or a building/floor manager for every building/floor listed (not just some
 * of them — managing one of five buildings a ballot spans doesn't entitle you
 * to run a draw across the other four).
 *
 * scopeAllBuildings is SUPER_ADMIN only — a building/floor manager's scope is
 * inherently bounded to what they manage, so org-wide reach isn't theirs to
 * claim. This must be checked explicitly and short-circuit before the
 * buildingIds/floorIds check below: when scopeAllBuildings is set,
 * buildingIds/floorIds are typically empty (per the create/update schema,
 * which allows an empty explicit scope only when scopeAllBuildings is true),
 * and `[].every(...)` is vacuously true — without this guard, ANY
 * non-super-admin caller would trivially pass the scope check for an
 * org-wide ballot.
 */
async function canManageBallotScope(userId: string, isSuperAdmin: boolean, buildingIds: string[], floorIds: string[], scopeAllBuildings: boolean): Promise<boolean> {
  if (isSuperAdmin) return true
  if (scopeAllBuildings) return false
  const [managedBuildingIds, managedFloorIds] = await Promise.all([getManagedBuildingIds(userId), getManagedFloorIds(userId)])
  const buildingSet = new Set(managedBuildingIds)
  const floorSet = new Set(managedFloorIds)
  return buildingIds.every((id) => buildingSet.has(id)) && floorIds.every((id) => floorSet.has(id))
}

/**
 * True when the user has access to at least one building/floor in the
 * ballot's scope — eligibility for entering/seeing a ballot is "you can
 * reach at least one of the assets it might draw from", not "you can
 * reach all of them" (unlike canManageBallotScope, which is about who may
 * *run* it).
 */
async function hasBallotScopeAccess(userId: string, ballot: { buildingIds: string[]; floorIds: string[]; scopeAllBuildings: boolean }): Promise<boolean> {
  if (ballot.scopeAllBuildings) {
    const floors = await prisma.floor.findMany({ select: { id: true, buildingId: true } })
    for (const f of floors) {
      if (await checkGroupAccess(userId, f.buildingId, f.id)) return true
    }
    return false
  }
  for (const buildingId of ballot.buildingIds) {
    const floors = await prisma.floor.findMany({ where: { buildingId }, select: { id: true } })
    for (const f of floors) {
      if (await checkGroupAccess(userId, buildingId, f.id)) return true
    }
  }
  for (const floorId of ballot.floorIds) {
    const floor = await prisma.floor.findUnique({ where: { id: floorId }, select: { buildingId: true } })
    if (floor && await checkGroupAccess(userId, floor.buildingId, floorId)) return true
  }
  return false
}

const ballotSelect = {
  id: true, name: true, createdByUserId: true, buildingIds: true, floorIds: true, scopeAllBuildings: true, assetCategoryIds: true,
  frequency: true, dayOfWeek: true, dayOfMonth: true, registrationWindowHours: true,
  slotStartTime: true, slotEndTime: true, slotLeadDays: true, slotDurationDays: true,
  status: true, createdAt: true, updatedAt: true,
  _count: { select: { runs: true } },
} as const

export async function ballotRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.addHook('onRoute', (route) => { route.schema = { tags: ['Ballots'], ...route.schema } })

  // ─── Admin: template CRUD ──────────────────────────────────────────────────

  // POST /ballots — create a ballot template (SUPER_ADMIN or building/floor manager of the whole scope)
  fastify.post('/', { preHandler: [requireAuth] }, async (request, reply) => {
    const result = createBallotSchema.safeParse(request.body)
    if (!result.success) {
      return reply.status(400).send({ error: { message: 'Validation failed', code: 'VALIDATION_ERROR', details: result.error.flatten() } })
    }
    const isSuperAdmin = request.user.globalRole === GlobalRole.SUPER_ADMIN
    if (!(await canManageBallotScope(request.user.id, isSuperAdmin, result.data.buildingIds, result.data.floorIds, result.data.scopeAllBuildings))) {
      return reply.status(403).send({ error: { message: 'Insufficient permissions for this scope', code: 'FORBIDDEN' } })
    }

    const ballot = await prisma.ballot.create({
      data: { ...result.data, createdByUserId: request.user.id },
      select: ballotSelect,
    })
    await recordAuditLog(prisma, {
      actorId: request.user.id,
      action: 'ballot.created',
      resourceType: 'Ballot',
      resourceId: ballot.id,
      after: { name: ballot.name, buildingIds: ballot.buildingIds, floorIds: ballot.floorIds, frequency: ballot.frequency },
      ipAddress: request.ip,
    }, request.log)
    // A ONCE ballot's single run opens immediately; a recurring one waits
    // for its first scheduled cycle via the ballot-open-registration cron.
    if (ballot.frequency === 'ONCE') {
      await ensureNextBallotRun(ballot.id, { actorId: request.user.id })
    }
    return reply.status(201).send({ data: ballot })
  })

  // GET /ballots — list ballots the caller can manage (SUPER_ADMIN sees all; others see their own)
  fastify.get('/', { preHandler: [requireAuth] }, async (request, reply) => {
    const isSuperAdmin = request.user.globalRole === GlobalRole.SUPER_ADMIN
    const ballots = await prisma.ballot.findMany({
      where: isSuperAdmin ? undefined : { createdByUserId: request.user.id },
      select: ballotSelect,
      orderBy: { createdAt: 'desc' },
    })
    return reply.status(200).send({ data: ballots })
  })

  // GET /ballots/:id — detail
  fastify.get('/:id', { preHandler: [requireAuth] }, async (request, reply) => {
    const { id } = request.params as { id: string }
    const ballot = await prisma.ballot.findUnique({ where: { id }, select: ballotSelect })
    if (!ballot) return reply.status(404).send({ error: { message: 'Ballot not found', code: 'NOT_FOUND' } })
    const isSuperAdmin = request.user.globalRole === GlobalRole.SUPER_ADMIN
    if (!(await canManageBallotScope(request.user.id, isSuperAdmin, ballot.buildingIds, ballot.floorIds, ballot.scopeAllBuildings))) {
      return reply.status(403).send({ error: { message: 'Insufficient permissions', code: 'FORBIDDEN' } })
    }
    return reply.status(200).send({ data: ballot })
  })

  // PATCH /ballots/:id — update scope/schedule/status
  fastify.patch('/:id', { preHandler: [requireAuth] }, async (request, reply) => {
    const { id } = request.params as { id: string }
    const result = updateBallotSchema.safeParse(request.body)
    if (!result.success) {
      return reply.status(400).send({ error: { message: 'Validation failed', code: 'VALIDATION_ERROR', details: result.error.flatten() } })
    }
    const existing = await prisma.ballot.findUnique({ where: { id } })
    if (!existing) return reply.status(404).send({ error: { message: 'Ballot not found', code: 'NOT_FOUND' } })
    const isSuperAdmin = request.user.globalRole === GlobalRole.SUPER_ADMIN
    if (!(await canManageBallotScope(request.user.id, isSuperAdmin, existing.buildingIds, existing.floorIds, existing.scopeAllBuildings))) {
      return reply.status(403).send({ error: { message: 'Insufficient permissions', code: 'FORBIDDEN' } })
    }
    // If the scope is being widened, the caller must also manage the NEW scope.
    const newBuildingIds = result.data.buildingIds ?? existing.buildingIds
    const newFloorIds = result.data.floorIds ?? existing.floorIds
    const newScopeAllBuildings = result.data.scopeAllBuildings ?? existing.scopeAllBuildings
    if (!(await canManageBallotScope(request.user.id, isSuperAdmin, newBuildingIds, newFloorIds, newScopeAllBuildings))) {
      return reply.status(403).send({ error: { message: 'Insufficient permissions for the new scope', code: 'FORBIDDEN' } })
    }

    const updated = await prisma.ballot.update({ where: { id }, data: result.data, select: ballotSelect })
    await recordAuditLog(prisma, {
      actorId: request.user.id,
      action: 'ballot.updated',
      resourceType: 'Ballot',
      resourceId: id,
      before: { name: existing.name, buildingIds: existing.buildingIds, floorIds: existing.floorIds, status: existing.status },
      after: { name: updated.name, buildingIds: updated.buildingIds, floorIds: updated.floorIds, status: updated.status },
      ipAddress: request.ip,
    }, request.log)
    return reply.status(200).send({ data: updated })
  })

  // DELETE /ballots/:id — cascades runs/entries. Does NOT cancel already-won bookings (they behave like any other booking from here on).
  fastify.delete('/:id', { preHandler: [requireAuth] }, async (request, reply) => {
    const { id } = request.params as { id: string }
    const existing = await prisma.ballot.findUnique({ where: { id } })
    if (!existing) return reply.status(404).send({ error: { message: 'Ballot not found', code: 'NOT_FOUND' } })
    const isSuperAdmin = request.user.globalRole === GlobalRole.SUPER_ADMIN
    if (!(await canManageBallotScope(request.user.id, isSuperAdmin, existing.buildingIds, existing.floorIds, existing.scopeAllBuildings))) {
      return reply.status(403).send({ error: { message: 'Insufficient permissions', code: 'FORBIDDEN' } })
    }
    await prisma.ballot.delete({ where: { id } })
    await recordAuditLog(prisma, {
      actorId: request.user.id,
      action: 'ballot.deleted',
      resourceType: 'Ballot',
      resourceId: id,
      before: { name: existing.name, buildingIds: existing.buildingIds, floorIds: existing.floorIds },
      ipAddress: request.ip,
    }, request.log)
    return reply.status(200).send({ data: { ok: true } })
  })

  // GET /ballots/:id/runs — list runs for a ballot
  fastify.get('/:id/runs', { preHandler: [requireAuth] }, async (request, reply) => {
    const { id } = request.params as { id: string }
    const ballot = await prisma.ballot.findUnique({ where: { id } })
    if (!ballot) return reply.status(404).send({ error: { message: 'Ballot not found', code: 'NOT_FOUND' } })
    const isSuperAdmin = request.user.globalRole === GlobalRole.SUPER_ADMIN
    if (!(await canManageBallotScope(request.user.id, isSuperAdmin, ballot.buildingIds, ballot.floorIds, ballot.scopeAllBuildings))) {
      return reply.status(403).send({ error: { message: 'Insufficient permissions', code: 'FORBIDDEN' } })
    }
    const runs = await prisma.ballotRun.findMany({
      where: { ballotId: id },
      include: { _count: { select: { entries: true } } },
      orderBy: { registrationClosesAt: 'desc' },
    })
    return reply.status(200).send({ data: runs })
  })

  // POST /ballots/:id/runs/trigger — force-open the next run now, ahead of its normal schedule
  fastify.post('/:id/runs/trigger', { preHandler: [requireAuth] }, async (request, reply) => {
    const { id } = request.params as { id: string }
    const ballot = await prisma.ballot.findUnique({ where: { id } })
    if (!ballot) return reply.status(404).send({ error: { message: 'Ballot not found', code: 'NOT_FOUND' } })
    const isSuperAdmin = request.user.globalRole === GlobalRole.SUPER_ADMIN
    if (!(await canManageBallotScope(request.user.id, isSuperAdmin, ballot.buildingIds, ballot.floorIds, ballot.scopeAllBuildings))) {
      return reply.status(403).send({ error: { message: 'Insufficient permissions', code: 'FORBIDDEN' } })
    }
    if (ballot.status !== 'ACTIVE') {
      return reply.status(409).send({ error: { message: 'Ballot is not active', code: 'BALLOT_NOT_ACTIVE' } })
    }
    const created = await ensureNextBallotRun(id, { force: true, actorId: request.user.id })
    if (!created) {
      // `force: true` bypasses the schedule gate, so this can only mean a
      // run already exists — either a ONCE ballot's one-and-only run, or a
      // recurring ballot's current cycle (already opened by an earlier
      // trigger or by the cron beating this request to it).
      return reply.status(409).send({ error: { message: 'A run for this ballot is already open', code: 'RUN_ALREADY_EXISTS' } })
    }
    return reply.status(200).send({ data: { ok: true } })
  })

  // GET /ballots/runs/:runId — admin results view (entries + who got what)
  fastify.get('/runs/:runId', { preHandler: [requireAuth] }, async (request, reply) => {
    const { runId } = request.params as { runId: string }
    const run = await prisma.ballotRun.findUnique({
      where: { id: runId },
      include: {
        ballot: true,
        entries: {
          include: {
            user: { select: { id: true, displayName: true, email: true } },
            asset: { select: { id: true, name: true } },
          },
          orderBy: { createdAt: 'asc' },
        },
      },
    })
    if (!run) return reply.status(404).send({ error: { message: 'Run not found', code: 'NOT_FOUND' } })
    const isSuperAdmin = request.user.globalRole === GlobalRole.SUPER_ADMIN
    if (!(await canManageBallotScope(request.user.id, isSuperAdmin, run.ballot.buildingIds, run.ballot.floorIds, run.ballot.scopeAllBuildings))) {
      return reply.status(403).send({ error: { message: 'Insufficient permissions', code: 'FORBIDDEN' } })
    }
    const poolSize = (await resolveBallotAssetPool(run.ballot)).length
    return reply.status(200).send({ data: { ...run, poolSize } })
  })

  // POST /ballots/runs/:runId/draw — force the draw now, ahead of registrationClosesAt
  fastify.post('/runs/:runId/draw', { preHandler: [requireAuth] }, async (request, reply) => {
    const { runId } = request.params as { runId: string }
    const run = await prisma.ballotRun.findUnique({ where: { id: runId }, include: { ballot: true } })
    if (!run) return reply.status(404).send({ error: { message: 'Run not found', code: 'NOT_FOUND' } })
    const isSuperAdmin = request.user.globalRole === GlobalRole.SUPER_ADMIN
    if (!(await canManageBallotScope(request.user.id, isSuperAdmin, run.ballot.buildingIds, run.ballot.floorIds, run.ballot.scopeAllBuildings))) {
      return reply.status(403).send({ error: { message: 'Insufficient permissions', code: 'FORBIDDEN' } })
    }
    if (run.status !== 'OPEN') {
      return reply.status(409).send({ error: { message: 'This run has already been drawn or cancelled', code: 'RUN_NOT_OPEN' } })
    }
    await runDrawForRun(runId, request.user.id)
    return reply.status(200).send({ data: { ok: true } })
  })

  // ─── User-facing: browse, enter, and see results ───────────────────────────

  // GET /ballots/available — open runs the caller has access to and hasn't yet been resolved for
  fastify.get('/available', { preHandler: [requireAuth] }, async (request, reply) => {
    const isSuperAdmin = request.user.globalRole === GlobalRole.SUPER_ADMIN
    const openRuns = await prisma.ballotRun.findMany({
      where: { status: 'OPEN', registrationOpensAt: { lte: new Date() } },
      include: {
        ballot: true,
        entries: { where: { userId: request.user.id }, select: { id: true, status: true } },
      },
      orderBy: { registrationClosesAt: 'asc' },
    })

    const eligible = []
    for (const run of openRuns) {
      if (run.ballot.status !== 'ACTIVE') continue
      if (!isSuperAdmin && !(await hasBallotScopeAccess(request.user.id, run.ballot))) continue
      eligible.push({ ...run, myEntry: run.entries[0] ?? null, entries: undefined })
    }

    return reply.status(200).send({ data: eligible })
  })

  // POST /ballots/runs/:runId/enter — opt in
  fastify.post('/runs/:runId/enter', { preHandler: [requireAuth] }, async (request, reply) => {
    const { runId } = request.params as { runId: string }
    const run = await prisma.ballotRun.findUnique({ where: { id: runId }, include: { ballot: true } })
    if (!run) return reply.status(404).send({ error: { message: 'Run not found', code: 'NOT_FOUND' } })
    // <= (not <) so the exact registrationClosesAt instant is already
    // closed — matches the draw-eligibility sweep in lib/ballot.ts, which
    // selects runs via `registrationClosesAt: { lte: new Date() }` (i.e.
    // already eligible to draw at that same instant). "Closes at X" should
    // mean X itself is closed; the stricter `<` here left a one-instant
    // window where a request landing at exactly that millisecond could be
    // accepted into a run the sweep already considers ready to draw.
    if (run.status !== 'OPEN' || run.registrationClosesAt <= new Date()) {
      return reply.status(409).send({ error: { message: 'Registration is not open for this run', code: 'REGISTRATION_CLOSED' } })
    }
    const isSuperAdmin = request.user.globalRole === GlobalRole.SUPER_ADMIN
    if (!isSuperAdmin && !(await hasBallotScopeAccess(request.user.id, run.ballot))) {
      return reply.status(403).send({ error: { message: "You do not have access to this ballot's scope", code: 'FORBIDDEN' } })
    }

    try {
      const entry = await prisma.ballotEntry.create({ data: { runId, userId: request.user.id } })
      await recordAuditLog(prisma, {
        actorId: request.user.id,
        action: 'ballot_entry.entered',
        resourceType: 'BallotEntry',
        resourceId: entry.id,
        after: { runId, userId: request.user.id },
        ipAddress: request.ip,
      }, request.log)
      return reply.status(201).send({ data: entry })
    } catch {
      return reply.status(409).send({ error: { message: 'You have already entered this ballot', code: 'ALREADY_ENTERED' } })
    }
  })

  // DELETE /ballots/runs/:runId/enter — withdraw before the draw
  fastify.delete('/runs/:runId/enter', { preHandler: [requireAuth] }, async (request, reply) => {
    const { runId } = request.params as { runId: string }
    const entry = await prisma.ballotEntry.findUnique({ where: { runId_userId: { runId, userId: request.user.id } } })
    if (!entry) return reply.status(404).send({ error: { message: 'You have not entered this ballot', code: 'NOT_FOUND' } })
    if (entry.status !== 'ENTERED') {
      return reply.status(409).send({ error: { message: 'This ballot has already been drawn', code: 'ALREADY_DRAWN' } })
    }
    // Guarded on status: 'ENTERED', not a bare delete-by-id — the check
    // above reads via a plain findUnique with no lock, so a withdrawal
    // racing the exact moment the draw cron reaches this same entry could
    // otherwise delete a row the draw is mid-way through marking WON/LOST.
    // runDrawForRun's own writes are now guarded the same way (updateMany +
    // status check), so whichever side actually wins the row in the
    // database is the one that takes effect; this one correctly reports
    // "already drawn" instead of silently deleting a just-won entry out
    // from under its own real, already-created booking.
    const withdrawn = await prisma.ballotEntry.deleteMany({ where: { id: entry.id, status: 'ENTERED' } })
    if (withdrawn.count === 0) {
      return reply.status(409).send({ error: { message: 'This ballot has already been drawn', code: 'ALREADY_DRAWN' } })
    }
    await recordAuditLog(prisma, {
      actorId: request.user.id,
      action: 'ballot_entry.withdrawn',
      resourceType: 'BallotEntry',
      resourceId: entry.id,
      before: { runId, userId: request.user.id },
      ipAddress: request.ip,
    }, request.log)
    return reply.status(200).send({ data: { ok: true } })
  })

  // GET /ballots/my-entries — the caller's own entries, any status
  fastify.get('/my-entries', { preHandler: [requireAuth] }, async (request, reply) => {
    const entries = await prisma.ballotEntry.findMany({
      where: { userId: request.user.id },
      include: {
        run: { include: { ballot: { select: { id: true, name: true } } } },
        asset: { select: { id: true, name: true } },
        booking: { select: { id: true, startsAt: true, endsAt: true, status: true, asset: { select: { floor: { select: { buildingId: true } } } } } },
      },
      orderBy: { createdAt: 'desc' },
    })
    // A won entry's booking is a real, timezone-resolved instant (unlike
    // slotStartsAt/slotEndsAt below, which are date-only) — attach the same
    // resolvedTimezone every other booking listing exposes (see GET / and
    // /pending-approvals in bookings.ts) so the frontend renders it in the
    // building's own timezone instead of the viewer's browser timezone.
    const tzCache = new Map<string, Promise<string>>()
    const resolveTz = (buildingId: string | null | undefined) => {
      const key = buildingId ?? ''
      if (!tzCache.has(key)) tzCache.set(key, resolveBuildingTimezone(prisma, buildingId))
      return tzCache.get(key)!
    }
    const withTz = await Promise.all(entries.map(async (e) => {
      if (!e.booking) return e
      const resolvedTimezone = await resolveTz(e.booking.asset?.floor?.buildingId)
      const { asset: _bookingAsset, ...booking } = e.booking
      return { ...e, booking: { ...booking, resolvedTimezone } }
    }))
    return reply.status(200).send({ data: withTz })
  })

  // POST /ballots/entries/:id/decline — decline a won assignment
  fastify.post('/entries/:id/decline', { preHandler: [requireAuth] }, async (request, reply) => {
    const { id } = request.params as { id: string }
    const outcome = await declineBallotEntry(id, request.user.id)
    if (!outcome.ok) {
      return reply.status(outcome.status).send({ error: { message: outcome.message, code: outcome.code } })
    }
    return reply.status(200).send({ data: { ok: true } })
  })
}
