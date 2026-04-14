import fs from 'fs'
import type { FastifyInstance } from 'fastify'
import { prisma } from '../lib/prisma'
import { GlobalRole } from '@roomer/shared'
import { requireAuth } from '../middleware/requireAuth'
import { requireGlobalRole } from '../middleware/requireRole'
import { resolveStoragePath } from '../lib/storage'
import { env } from '../env'
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

const adminHandlers = [requireAuth, requireGlobalRole(GlobalRole.SUPER_ADMIN)]

export async function leaseRoutes(fastify: FastifyInstance): Promise<void> {
  // GET /leases?buildingId= — list leases
  fastify.get('/', { preHandler: adminHandlers }, async (request, reply) => {
    const { buildingId } = request.query as { buildingId?: string }

    const leases = await prisma.buildingLease.findMany({
      where: buildingId ? { buildingId } : undefined,
      include: {
        building: { select: { id: true, name: true } },
        documents: { select: { id: true, filename: true, sizeBytes: true, mimeType: true, uploadedAt: true } },
      },
      orderBy: { startDate: 'desc' },
    })

    return reply.status(200).send({ data: leases })
  })

  // POST /leases — create lease
  fastify.post('/', { preHandler: adminHandlers }, async (request, reply) => {
    const result = createLeaseSchema.safeParse(request.body)
    if (!result.success) {
      return reply.status(400).send({
        error: { message: 'Validation failed', code: 'VALIDATION_ERROR', details: result.error.flatten() },
      })
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

  // GET /leases/:id — get lease detail
  fastify.get('/:id', { preHandler: adminHandlers }, async (request, reply) => {
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

    return reply.status(200).send({ data: lease })
  })

  // PUT /leases/:id — update lease
  fastify.put('/:id', { preHandler: adminHandlers }, async (request, reply) => {
    const { id } = request.params as { id: string }
    const result = updateLeaseSchema.safeParse(request.body)
    if (!result.success) {
      return reply.status(400).send({
        error: { message: 'Validation failed', code: 'VALIDATION_ERROR', details: result.error.flatten() },
      })
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

  // DELETE /leases/:id — delete lease (cascades documents)
  fastify.delete('/:id', { preHandler: adminHandlers }, async (request, reply) => {
    const { id } = request.params as { id: string }

    const lease = await prisma.buildingLease.findUnique({
      where: { id },
      include: { documents: true },
    })

    if (!lease) {
      return reply.status(404).send({ error: { message: 'Lease not found', code: 'NOT_FOUND' } })
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

  // POST /leases/:id/documents — upload document
  fastify.post('/:id/documents', { preHandler: adminHandlers }, async (request, reply) => {
    const { id } = request.params as { id: string }

    const lease = await prisma.buildingLease.findUnique({ where: { id } })
    if (!lease) {
      return reply.status(404).send({ error: { message: 'Lease not found', code: 'NOT_FOUND' } })
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

    // Save file (store relative path like floor plans)
    const relDir = path.join('leases', id)
    const absDir = resolveStoragePath(relDir)
    await fs.promises.mkdir(absDir, { recursive: true })
    const safeFilename = `${Date.now()}-${data.filename.replace(/[^a-zA-Z0-9._-]/g, '_')}`
    const relPath = path.join(relDir, safeFilename)
    const absPath = resolveStoragePath(relPath)
    const buffer = await data.toBuffer()
    await fs.promises.writeFile(absPath, buffer)

    const doc = await prisma.leaseDocument.create({
      data: {
        leaseId: id,
        filename: data.filename,
        storagePath: relPath,
        mimeType: data.mimetype,
        sizeBytes: buffer.length,
      },
    })

    return reply.status(201).send({ data: doc })
  })

  // GET /leases/:id/documents/:docId — download document
  fastify.get('/:id/documents/:docId', { preHandler: adminHandlers }, async (request, reply) => {
    const { docId } = request.params as { id: string; docId: string }

    const doc = await prisma.leaseDocument.findUnique({ where: { id: docId } })
    if (!doc) {
      return reply.status(404).send({ error: { message: 'Document not found', code: 'NOT_FOUND' } })
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

  // DELETE /leases/:id/documents/:docId — delete document
  fastify.delete('/:id/documents/:docId', { preHandler: adminHandlers }, async (request, reply) => {
    const { docId } = request.params as { id: string; docId: string }

    const doc = await prisma.leaseDocument.findUnique({ where: { id: docId } })
    if (!doc) {
      return reply.status(404).send({ error: { message: 'Document not found', code: 'NOT_FOUND' } })
    }

    const absPath = resolveStoragePath(doc.storagePath)
    try { await fs.promises.unlink(absPath) } catch { /* ignore */ }

    await prisma.leaseDocument.delete({ where: { id: docId } })
    return reply.status(200).send({ data: { ok: true } })
  })
}
