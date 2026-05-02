import fs from 'fs'
import type { FastifyInstance } from 'fastify'
import { prisma } from '../lib/prisma'
import { GlobalRole } from '@roomer/shared'
import { requireAuth } from '../middleware/requireAuth'
import { isBuildingManagerForBuilding, getManagedBuildingIds } from '../middleware/requireRole'
import { resolveStoragePath, checkFileMagic } from '../lib/storage'
import path from 'path'
import { z } from 'zod'

const createLeaseSchema = z.object({
  buildingId: z.string().min(1),
  name: z.string().min(1).max(255),
  startDate: z.string().datetime(),
  endDate: z.string().datetime().optional(),
  landlord: z.string().max(255).optional(),
  rentAmount: z.number().positive().optional(),
  currency: z.string().length(3).default('AUD'),
  notes: z.string().optional(),
})

const updateLeaseSchema = z.object({
  name: z.string().min(1).max(255).optional(),
  startDate: z.string().datetime().optional(),
  endDate: z.string().datetime().optional(),
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

    const existing = await prisma.buildingLease.findUnique({ where: { id }, select: { buildingId: true } })
    if (!existing) {
      return reply.status(404).send({ error: { message: 'Lease not found', code: 'NOT_FOUND' } })
    }

    if (request.user.globalRole !== GlobalRole.SUPER_ADMIN) {
      const ok = await isBuildingManagerForBuilding(request.user.id, existing.buildingId)
      if (!ok) {
        return reply.status(403).send({ error: { message: 'Insufficient permissions', code: 'FORBIDDEN' } })
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
        },
        include: {
          building: { select: { id: true, name: true } },
          documents: { select: { id: true, filename: true, sizeBytes: true, mimeType: true, uploadedAt: true } },
        },
      })
      return reply.status(200).send({ data: lease })
    } catch {
      return reply.status(404).send({ error: { message: 'Lease not found', code: 'NOT_FOUND' } })
    }
  })

  // DELETE /leases/:id — delete lease (SUPER_ADMIN or building admin)
  fastify.delete('/:id', { preHandler: [requireAuth], config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (request, reply) => {
    const { id } = request.params as { id: string }

    const lease = await prisma.buildingLease.findUnique({
      where: { id },
      include: { documents: true },
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

    // Delete stored document files
    for (const doc of lease.documents) {
      const absPath = resolveStoragePath(doc.storagePath)
      try {
        await fs.promises.unlink(absPath)
      } catch {
        // Ignore missing files
      }
    }

    await prisma.buildingLease.delete({ where: { id } })
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

    const doc = await prisma.leaseDocument.create({
      data: {
        leaseId: id,
        filename: safeDisplayFilename,
        storagePath: relPath,
        mimeType: data.mimetype,
        sizeBytes: buffer.length,
      },
    })

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
    return reply.status(200).send({ data: { ok: true } })
  })
}
