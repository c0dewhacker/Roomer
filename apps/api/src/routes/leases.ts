import fs from 'fs'
import type { FastifyInstance } from 'fastify'
import { prisma } from '../lib/prisma.js'
import { GlobalRole } from '@roomer/shared'
import { requireAuth } from '../middleware/requireAuth.js'
import { isBuildingManagerForBuilding, getManagedBuildingIds } from '../middleware/requireRole.js'
import { resolveBuildingTimezone, calendarDaysUntil } from '../lib/timezone.js'
import { resolveStoragePath, checkFileMagic } from '../lib/storage.js'
import { recordAuditLog } from '../lib/audit.js'
import path from 'path'
import { z } from 'zod'

/**
 * Serializes DELETE /leases/:id against POST /leases/:id/documents for the
 * same lease — without it, a document upload that commits between the
 * delete's pre-cleanup snapshot and its actual buildingLease.delete is
 * invisible to that snapshot: LeaseDocument cascades away with the lease,
 * but the file it pointed at was never scheduled for unlink, leaking it on
 * disk forever. Keyed on the lease id. 4251 — next unused
 * pg_advisory_xact_lock classid; grep the whole repo for `_LOCK_CLASS = `
 * before reusing (see SCIM_GROUP_NAME_LOCK_CLASS's own doc comment for why
 * that matters).
 *
 * Exported so buildings.ts DELETE /:id can take it per-lease before its own
 * pre-delete leaseDocuments snapshot — that route deletes every lease under
 * a building via cascade, and locking only the Floor rows it already locks
 * doesn't serialize against this lease-scoped lock at all.
 */
export const LEASE_DOCUMENT_LOCK_CLASS = 4251

// .trim() before .min(1) on name — see schemas/department.ts for why.
const createLeaseSchema = z.object({
  buildingId: z.string().min(1),
  name: z.string().trim().min(1).max(255),
  startDate: z.string().datetime(),
  endDate: z.string().datetime().optional(),
  landlord: z.string().max(255).optional(),
  rentAmount: z.number().positive().optional(),
  currency: z.string().length(3).default('AUD'),
  notes: z.string().optional(),
})
// Date-ordering is checked explicitly in the route handlers below (POST and
// PUT), not via a schema .refine() — a refine's failure surfaces to the
// client as the generic "Validation failed" wrapper (the specific message
// lives in details.fieldErrors, which the frontend's error toast doesn't
// read), whereas an explicit handler-level check can return a clear,
// specific top-level message. PUT also needs this as a plain function
// anyway, since it must validate the *merged* effective dates rather than
// just the raw request body — either field can be omitted to mean "keep
// the existing value" (the same partial-update gap already fixed for
// bookings in db8fd79).
function datesAreOrdered(startDate: Date, endDate: Date | null): boolean {
  return !endDate || startDate < endDate
}

const updateLeaseSchema = z.object({
  name: z.string().trim().min(1).max(255).optional(),
  startDate: z.string().datetime().optional(),
  // Nullable (not just optional): the frontend sends `endDate: null` to clear
  // an existing end date and make the lease open-ended, distinct from
  // omitting the field to mean "leave it unchanged" (see the handler's
  // `!== undefined` merge logic below).
  endDate: z.string().datetime().nullable().optional(),
  landlord: z.string().max(255).optional(),
  rentAmount: z.number().positive().optional(),
  currency: z.string().length(3).optional(),
  notes: z.string().optional(),
})

export async function leaseRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.addHook('onRoute', (route) => { route.schema = { tags: ['Leases'], ...route.schema } })

  // GET /leases?buildingId= — list leases (SUPER_ADMIN or building admin, scoped to managed buildings)
  fastify.get('/', { preHandler: [requireAuth] }, async (request, reply) => {
    const queryResult = z.object({ buildingId: z.string().cuid().optional() }).safeParse(request.query)
    if (!queryResult.success) {
      return reply.status(400).send({ error: { message: 'Invalid query parameters', code: 'VALIDATION_ERROR' } })
    }
    const { buildingId } = queryResult.data

    const isSuperAdmin = request.user.globalRole === GlobalRole.SUPER_ADMIN
    let where: Record<string, unknown> | undefined

    if (isSuperAdmin) {
      where = buildingId ? { buildingId } : undefined
    } else {
      const managedIds = await getManagedBuildingIds(request.user.id)
      if (managedIds.length === 0) {
        return reply.status(403).send({ error: { message: 'Insufficient permissions', code: 'FORBIDDEN' } })
      }
      if (buildingId) {
        if (!managedIds.includes(buildingId)) {
          return reply.status(403).send({ error: { message: 'Insufficient permissions', code: 'FORBIDDEN' } })
        }
        where = { buildingId }
      } else {
        where = { buildingId: { in: managedIds } }
      }
    }

    const leases = await prisma.buildingLease.findMany({
      where,
      include: {
        building: { select: { id: true, name: true } },
        documents: { select: { id: true, filename: true, sizeBytes: true, mimeType: true, uploadedAt: true } },
      },
      orderBy: { startDate: 'desc' },
    })

    return reply.status(200).send({ data: leases })
  })

  // POST /leases — create lease (SUPER_ADMIN or building admin of the target building)
  fastify.post('/', { preHandler: [requireAuth] }, async (request, reply) => {
    const result = createLeaseSchema.safeParse(request.body)
    if (!result.success) {
      return reply.status(400).send({
        error: { message: 'Validation failed', code: 'VALIDATION_ERROR', details: result.error.flatten() },
      })
    }

    const parsedEndDate = result.data.endDate ? new Date(result.data.endDate) : null
    if (!datesAreOrdered(new Date(result.data.startDate), parsedEndDate)) {
      return reply.status(400).send({ error: { message: 'startDate must be before endDate', code: 'VALIDATION_ERROR' } })
    }

    if (request.user.globalRole !== GlobalRole.SUPER_ADMIN) {
      const ok = await isBuildingManagerForBuilding(request.user.id, result.data.buildingId)
      if (!ok) {
        return reply.status(403).send({ error: { message: 'Insufficient permissions', code: 'FORBIDDEN' } })
      }
    }

    const building = await prisma.building.findUnique({ where: { id: result.data.buildingId } })
    if (!building) {
      return reply.status(404).send({ error: { message: 'Building not found', code: 'NOT_FOUND' } })
    }

    const lease = await prisma.buildingLease.create({
      data: {
        buildingId: result.data.buildingId,
        name: result.data.name,
        startDate: new Date(result.data.startDate),
        endDate: result.data.endDate ? new Date(result.data.endDate) : null,
        landlord: result.data.landlord ?? null,
        rentAmount: result.data.rentAmount ?? null,
        currency: result.data.currency,
        notes: result.data.notes ?? null,
      },
      include: {
        building: { select: { id: true, name: true } },
        documents: true,
      },
    })
    await recordAuditLog(prisma, {
      actorId: request.user.id,
      action: 'building_lease.created',
      resourceType: 'BuildingLease',
      resourceId: lease.id,
      after: { buildingId: lease.buildingId, name: lease.name, startDate: lease.startDate, endDate: lease.endDate, landlord: lease.landlord, rentAmount: lease.rentAmount, currency: lease.currency },
      ipAddress: request.ip,
    }, request.log)

    return reply.status(201).send({ data: lease })
  })

  // GET /leases/:id — get lease detail (SUPER_ADMIN or building admin)
  fastify.get('/:id', { preHandler: [requireAuth] }, async (request, reply) => {
    const { id } = request.params as { id: string }

    const lease = await prisma.buildingLease.findUnique({
      where: { id },
      include: {
        building: { select: { id: true, name: true } },
        documents: { orderBy: { uploadedAt: 'desc' } },
      },
    })

    if (!lease) {
      return reply.status(404).send({ error: { message: 'Lease not found', code: 'NOT_FOUND' } })
    }

    if (request.user.globalRole !== GlobalRole.SUPER_ADMIN) {
      const ok = await isBuildingManagerForBuilding(request.user.id, lease.buildingId)
      if (!ok) {
        return reply.status(403).send({ error: { message: 'Insufficient permissions', code: 'FORBIDDEN' } })
      }
    }

    return reply.status(200).send({ data: lease })
  })

  // PUT /leases/:id — update lease (SUPER_ADMIN or building admin)
  fastify.put('/:id', { preHandler: [requireAuth] }, async (request, reply) => {
    const { id } = request.params as { id: string }
    const result = updateLeaseSchema.safeParse(request.body)
    if (!result.success) {
      return reply.status(400).send({
        error: { message: 'Validation failed', code: 'VALIDATION_ERROR', details: result.error.flatten() },
      })
    }

    const existing = await prisma.buildingLease.findUnique({ where: { id }, select: { buildingId: true, name: true, startDate: true, endDate: true, landlord: true, rentAmount: true, currency: true } })
    if (!existing) {
      return reply.status(404).send({ error: { message: 'Lease not found', code: 'NOT_FOUND' } })
    }

    if (request.user.globalRole !== GlobalRole.SUPER_ADMIN) {
      const ok = await isBuildingManagerForBuilding(request.user.id, existing.buildingId)
      if (!ok) {
        return reply.status(403).send({ error: { message: 'Insufficient permissions', code: 'FORBIDDEN' } })
      }
    }

    // Either field can be omitted here to mean "keep the existing value", so
    // validate the merged effective dates rather than just the raw request
    // body (same partial-update gap already fixed for bookings in db8fd79).
    const effectiveStartDate = result.data.startDate ? new Date(result.data.startDate) : existing.startDate
    const effectiveEndDate = result.data.endDate !== undefined
      ? (result.data.endDate ? new Date(result.data.endDate) : null)
      : existing.endDate
    if (!datesAreOrdered(effectiveStartDate, effectiveEndDate)) {
      return reply.status(400).send({ error: { message: 'startDate must be before endDate', code: 'VALIDATION_ERROR' } })
    }

    // If endDate is actually changing, clear whichever expiry-notification
    // flag(s) no longer apply to the new date — otherwise a lease edited back
    // out of the expiring-soon window (or renewed past its old expiry) would
    // never re-notify if it later re-enters either state, since
    // handleLeaseExpiry only ever looks at leases where the flag is still
    // null. Only touched when endDate is part of this request; editing e.g.
    // just the rent amount must not reset either flag.
    //
    // endDate is a date-only value (UTC midnight of the picked calendar day),
    // not a real instant — classified via calendarDaysUntil against the
    // building's own timezone, the same fix already applied to the
    // lease-expiry cron (queue.ts) for this exact field. Comparing it as a
    // raw instant against `now` (as this used to) flips the classification a
    // day early/late depending on the building's UTC offset.
    let notifiedResets: { expiringNotifiedAt?: null; expiredNotifiedAt?: null } = {}
    if (result.data.endDate !== undefined) {
      const now = new Date()
      const tz = await resolveBuildingTimezone(prisma, existing.buildingId)
      const days = effectiveEndDate !== null ? calendarDaysUntil(effectiveEndDate, now, tz) : null
      const inExpiringWindow = days !== null && days >= 0 && days <= 90
      const isPast = days !== null && days < 0
      notifiedResets = {
        ...(!inExpiringWindow && { expiringNotifiedAt: null }),
        ...(!isPast && { expiredNotifiedAt: null }),
      }
    }

    try {
      const lease = await prisma.buildingLease.update({
        where: { id },
        data: {
          ...result.data,
          startDate: result.data.startDate ? new Date(result.data.startDate) : undefined,
          endDate: result.data.endDate !== undefined
            ? (result.data.endDate ? new Date(result.data.endDate) : null)
            : undefined,
          ...notifiedResets,
        },
        include: {
          building: { select: { id: true, name: true } },
          documents: { select: { id: true, filename: true, sizeBytes: true, mimeType: true, uploadedAt: true } },
        },
      })
      await recordAuditLog(prisma, {
        actorId: request.user.id,
        action: 'building_lease.updated',
        resourceType: 'BuildingLease',
        resourceId: id,
        before: existing,
        after: { name: lease.name, startDate: lease.startDate, endDate: lease.endDate, landlord: lease.landlord, rentAmount: lease.rentAmount, currency: lease.currency },
        ipAddress: request.ip,
      }, request.log)
      return reply.status(200).send({ data: lease })
    } catch {
      return reply.status(404).send({ error: { message: 'Lease not found', code: 'NOT_FOUND' } })
    }
  })

  // DELETE /leases/:id — delete lease (SUPER_ADMIN or building admin)
  fastify.delete('/:id', { preHandler: [requireAuth], config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (request, reply) => {
    const { id } = request.params as { id: string }

    // Lightweight pre-check for the auth decision only — buildingId doesn't
    // change, so no lock needed for this read.
    const authCheck = await prisma.buildingLease.findUnique({ where: { id }, select: { buildingId: true } })
    if (!authCheck) {
      return reply.status(404).send({ error: { message: 'Lease not found', code: 'NOT_FOUND' } })
    }
    if (request.user.globalRole !== GlobalRole.SUPER_ADMIN) {
      const ok = await isBuildingManagerForBuilding(request.user.id, authCheck.buildingId)
      if (!ok) {
        return reply.status(403).send({ error: { message: 'Insufficient permissions', code: 'FORBIDDEN' } })
      }
    }

    // The documents snapshot and the delete run inside one transaction,
    // under the lease-scoped advisory lock — see LEASE_DOCUMENT_LOCK_CLASS's
    // doc comment. Taking the snapshot here (after acquiring the lock)
    // rather than before this transaction means it always reflects whatever
    // POST /:id/documents last committed, since that route takes the same
    // lock before its own create.
    const lease = await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(${LEASE_DOCUMENT_LOCK_CLASS}, hashtext(${id}))`
      const lease = await tx.buildingLease.findUnique({ where: { id }, include: { documents: true } })
      if (!lease) return null
      await tx.buildingLease.delete({ where: { id } })
      return lease
    }).catch(() => null)

    if (!lease) {
      return reply.status(404).send({ error: { message: 'Lease not found', code: 'NOT_FOUND' } })
    }

    // File I/O stays outside the transaction/lock.
    for (const doc of lease.documents) {
      const absPath = resolveStoragePath(doc.storagePath)
      try {
        await fs.promises.unlink(absPath)
      } catch {
        // Ignore missing files
      }
    }

    await recordAuditLog(prisma, {
      actorId: request.user.id,
      action: 'building_lease.deleted',
      resourceType: 'BuildingLease',
      resourceId: id,
      before: { buildingId: lease.buildingId, name: lease.name, startDate: lease.startDate, endDate: lease.endDate, landlord: lease.landlord, rentAmount: lease.rentAmount, currency: lease.currency },
      ipAddress: request.ip,
    }, request.log)
    return reply.status(200).send({ data: { ok: true } })
  })

  // POST /leases/:id/documents — upload document (SUPER_ADMIN or building admin)
  fastify.post('/:id/documents', { preHandler: [requireAuth], config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (request, reply) => {
    const { id } = request.params as { id: string }

    if (!/^[\w-]{1,64}$/.test(id)) {
      return reply.status(400).send({ error: { message: 'Invalid lease ID', code: 'INVALID_INPUT' } })
    }

    const lease = await prisma.buildingLease.findUnique({ where: { id } })
    if (!lease) {
      return reply.status(404).send({ error: { message: 'Lease not found', code: 'NOT_FOUND' } })
    }

    if (request.user.globalRole !== GlobalRole.SUPER_ADMIN) {
      const ok = await isBuildingManagerForBuilding(request.user.id, lease.buildingId)
      if (!ok) {
        return reply.status(403).send({ error: { message: 'Insufficient permissions', code: 'FORBIDDEN' } })
      }
    }

    const data = await request.file()
    if (!data) {
      return reply.status(400).send({ error: { message: 'No file uploaded', code: 'NO_FILE' } })
    }

    const allowedMimes = [
      'application/pdf',
      'application/msword',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'image/png', 'image/jpeg',
    ]
    const ext = path.extname(data.filename).toLowerCase()
    const allowedExts = ['.pdf', '.doc', '.docx', '.png', '.jpg', '.jpeg']
    if (!allowedMimes.includes(data.mimetype) && !allowedExts.includes(ext)) {
      return reply.status(400).send({
        error: { message: 'Unsupported file type', code: 'INVALID_FILE_TYPE' },
      })
    }

    // Save file — use DB-sourced lease.id (not raw param) to avoid tainted path
    const relDir = path.join('leases', lease.id)
    const absDir = resolveStoragePath(relDir)
    await fs.promises.mkdir(absDir, { recursive: true })
    const safeFilename = `${Date.now()}-${data.filename.replace(/[^a-zA-Z0-9._-]/g, '_').replace(/\.{2,}/g, '_')}`
    const relPath = path.join(relDir, safeFilename)
    const absPath = resolveStoragePath(relPath)
    const buffer = await data.toBuffer()
    if (!checkFileMagic(buffer, data.mimetype)) {
      return reply.status(400).send({
        error: { message: 'File content does not match the declared type', code: 'INVALID_FILE_TYPE' },
      })
    }
    await fs.promises.writeFile(absPath, buffer)

    const safeDisplayFilename = data.filename
      .replace(/[\x00-\x1f\x7f]/g, '')     // strip control characters incl. null bytes
      .replace(/[‮‏​]/g, '') // strip Unicode directional/zero-width overrides
      .slice(0, 255)

    // Create under the same lease-scoped advisory lock DELETE /:id takes —
    // see LEASE_DOCUMENT_LOCK_CLASS's doc comment. Re-checks the lease still
    // exists after acquiring the lock: if a concurrent delete won the race
    // and already committed, this file (already written to disk above,
    // since that I/O has to happen before we know the outcome) would
    // otherwise become an orphan with no DB row ever pointing at it.
    const doc = await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(${LEASE_DOCUMENT_LOCK_CLASS}, hashtext(${id}))`
      const stillExists = await tx.buildingLease.findUnique({ where: { id }, select: { id: true } })
      if (!stillExists) return null
      return tx.leaseDocument.create({
        data: {
          leaseId: id,
          filename: safeDisplayFilename,
          storagePath: relPath,
          mimeType: data.mimetype,
          sizeBytes: buffer.length,
        },
      })
    })

    if (!doc) {
      await fs.promises.unlink(absPath).catch(() => {})
      return reply.status(404).send({ error: { message: 'Lease not found', code: 'NOT_FOUND' } })
    }

    await recordAuditLog(prisma, {
      actorId: request.user.id,
      action: 'lease_document.uploaded',
      resourceType: 'LeaseDocument',
      resourceId: doc.id,
      after: { leaseId: id, filename: doc.filename, mimeType: doc.mimeType, sizeBytes: doc.sizeBytes },
      ipAddress: request.ip,
    }, request.log)

    return reply.status(201).send({ data: doc })
  })

  // GET /leases/:id/documents/:docId — download document (SUPER_ADMIN or building admin)
  fastify.get('/:id/documents/:docId', { preHandler: [requireAuth], config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }, async (request, reply) => {
    const { id, docId } = request.params as { id: string; docId: string }

    const doc = await prisma.leaseDocument.findUnique({ where: { id: docId } })
    if (!doc || doc.leaseId !== id) {
      return reply.status(404).send({ error: { message: 'Document not found', code: 'NOT_FOUND' } })
    }

    if (request.user.globalRole !== GlobalRole.SUPER_ADMIN) {
      const lease = await prisma.buildingLease.findUnique({ where: { id }, select: { buildingId: true } })
      if (!lease) {
        return reply.status(404).send({ error: { message: 'Lease not found', code: 'NOT_FOUND' } })
      }
      const ok = await isBuildingManagerForBuilding(request.user.id, lease.buildingId)
      if (!ok) {
        return reply.status(403).send({ error: { message: 'Insufficient permissions', code: 'FORBIDDEN' } })
      }
    }

    const docAbsPath = resolveStoragePath(doc.storagePath)
    try {
      await fs.promises.access(docAbsPath, fs.constants.R_OK)
    } catch {
      return reply.status(404).send({ error: { message: 'File not found on disk', code: 'FILE_NOT_FOUND' } })
    }

    const stream = fs.createReadStream(docAbsPath)
    reply.header('Content-Type', doc.mimeType)
    reply.header('X-Content-Type-Options', 'nosniff')
    reply.header('Content-Disposition', `attachment; filename="${encodeURIComponent(doc.filename)}"`)
    return reply.send(stream)
  })

  // DELETE /leases/:id/documents/:docId — delete document (SUPER_ADMIN or building admin)
  // lgtm[js/missing-rate-limiting] - False positive: @fastify/rate-limit applied globally (app.ts) and per-route via config.rateLimit
  fastify.delete('/:id/documents/:docId', { preHandler: [requireAuth], config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (request, reply) => {
    const { id, docId } = request.params as { id: string; docId: string }

    const doc = await prisma.leaseDocument.findUnique({ where: { id: docId } })
    if (!doc || doc.leaseId !== id) {
      return reply.status(404).send({ error: { message: 'Document not found', code: 'NOT_FOUND' } })
    }

    if (request.user.globalRole !== GlobalRole.SUPER_ADMIN) {
      const lease = await prisma.buildingLease.findUnique({ where: { id }, select: { buildingId: true } })
      if (!lease) {
        return reply.status(404).send({ error: { message: 'Lease not found', code: 'NOT_FOUND' } })
      }
      const ok = await isBuildingManagerForBuilding(request.user.id, lease.buildingId)
      if (!ok) {
        return reply.status(403).send({ error: { message: 'Insufficient permissions', code: 'FORBIDDEN' } })
      }
    }

    const absPath = resolveStoragePath(doc.storagePath)
    try { await fs.promises.unlink(absPath) } catch { /* ignore */ }

    await prisma.leaseDocument.delete({ where: { id: docId } })
    await recordAuditLog(prisma, {
      actorId: request.user.id,
      action: 'lease_document.deleted',
      resourceType: 'LeaseDocument',
      resourceId: docId,
      before: { leaseId: doc.leaseId, filename: doc.filename, mimeType: doc.mimeType, sizeBytes: doc.sizeBytes },
      ipAddress: request.ip,
    }, request.log)
    return reply.status(200).send({ data: { ok: true } })
  })
}
