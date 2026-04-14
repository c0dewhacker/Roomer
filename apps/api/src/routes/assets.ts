import type { FastifyInstance } from 'fastify'
import { prisma } from '../lib/prisma'
import { GlobalRole } from '@roomer/shared'
import { requireAuth } from '../middleware/requireAuth'
import { requireGlobalRole } from '../middleware/requireRole'
import { z } from 'zod'

const createCategorySchema = z.object({
  name: z.string().min(1).max(255),
  description: z.string().optional(),
})

const createAssetSchema = z.object({
  categoryId: z.string().min(1),
  name: z.string().min(1).max(255),
  description: z.string().optional(),
  serialNumber: z.string().optional(),
  assetTag: z.string().optional(),
  purchaseDate: z.string().datetime().optional(),
  warrantyExpiry: z.string().datetime().optional(),
  notes: z.string().optional(),
})

const updateAssetSchema = z.object({
  categoryId: z.string().min(1).optional(),
  name: z.string().min(1).max(255).optional(),
  description: z.string().optional(),
  serialNumber: z.string().optional(),
  assetTag: z.string().optional(),
  status: z.enum(['AVAILABLE', 'ASSIGNED', 'MAINTENANCE', 'RETIRED']).optional(),
  purchaseDate: z.string().datetime().optional(),
  warrantyExpiry: z.string().datetime().optional(),
  notes: z.string().optional(),
})

const assignSchema = z.object({
  assigneeType: z.enum(['USER', 'DESK']),
  assigneeId: z.string(),
  notes: z.string().optional(),
})

export async function assetRoutes(fastify: FastifyInstance): Promise<void> {
  // GET / — list assets
  fastify.get('/', { preHandler: [requireAuth] }, async (request, reply) => {
    const isAdmin = request.user.globalRole === GlobalRole.SUPER_ADMIN

    if (isAdmin) {
      const assets = await prisma.asset.findMany({
        include: {
          category: true,
          assignments: {
            where: { returnedAt: null },
            include: {
              user: { select: { id: true, displayName: true, email: true } },
              desk: { select: { id: true, name: true } },
            },
          },
        },
        orderBy: { name: 'asc' },
      })
      return reply.status(200).send({ data: assets })
    }

    // Non-admin: return only assets assigned to this user
    const assignments = await prisma.assetAssignment.findMany({
      where: { userId: request.user.id, returnedAt: null },
      include: {
        asset: {
          include: { category: true },
        },
      },
    })

    return reply.status(200).send({ data: assignments.map((a) => a.asset) })
  })

  // GET /categories — list asset categories
  fastify.get('/categories', { preHandler: [requireAuth] }, async (_request, reply) => {
    const categories = await prisma.assetCategory.findMany({
      orderBy: { name: 'asc' },
      include: { _count: { select: { assets: true } } },
    })
    return reply.status(200).send({ data: categories })
  })

  // POST /categories — create category (admin)
  fastify.post(
    '/categories',
    { preHandler: [requireAuth, requireGlobalRole(GlobalRole.SUPER_ADMIN)] },
    async (request, reply) => {
      const result = createCategorySchema.safeParse(request.body)
      if (!result.success) {
        return reply.status(400).send({
          error: { message: 'Validation failed', code: 'VALIDATION_ERROR', details: result.error.flatten() },
        })
      }

      try {
        const category = await prisma.assetCategory.create({ data: result.data })
        return reply.status(201).send({ data: category })
      } catch {
        return reply.status(409).send({
          error: { message: 'Category name already exists', code: 'ALREADY_EXISTS' },
        })
      }
    },
  )

  // GET /:id — get asset detail
  fastify.get('/:id', { preHandler: [requireAuth] }, async (request, reply) => {
    const { id } = request.params as { id: string }

    const asset = await prisma.asset.findUnique({
      where: { id },
      include: {
        category: true,
        assignments: {
          include: {
            user: { select: { id: true, displayName: true, email: true } },
            desk: { select: { id: true, name: true } },
          },
          orderBy: { assignedAt: 'desc' },
        },
      },
    })

    if (!asset) {
      return reply.status(404).send({ error: { message: 'Asset not found', code: 'NOT_FOUND' } })
    }

    const isAdmin = request.user.globalRole === GlobalRole.SUPER_ADMIN
    if (!isAdmin) {
      const hasAccess = asset.assignments.some(
        (a) => a.userId === request.user.id && a.returnedAt === null,
      )
      if (!hasAccess) {
        return reply.status(403).send({ error: { message: 'Forbidden', code: 'FORBIDDEN' } })
      }
    }

    return reply.status(200).send({ data: asset })
  })

  // POST / — create asset (admin)
  fastify.post(
    '/',
    { preHandler: [requireAuth, requireGlobalRole(GlobalRole.SUPER_ADMIN)] },
    async (request, reply) => {
      const result = createAssetSchema.safeParse(request.body)
      if (!result.success) {
        return reply.status(400).send({
          error: { message: 'Validation failed', code: 'VALIDATION_ERROR', details: result.error.flatten() },
        })
      }

      const category = await prisma.assetCategory.findUnique({
        where: { id: result.data.categoryId },
      })
      if (!category) {
        return reply.status(404).send({ error: { message: 'Category not found', code: 'NOT_FOUND' } })
      }

      try {
        const asset = await prisma.asset.create({
          data: {
            ...result.data,
            purchaseDate: result.data.purchaseDate ? new Date(result.data.purchaseDate) : undefined,
            warrantyExpiry: result.data.warrantyExpiry ? new Date(result.data.warrantyExpiry) : undefined,
          },
          include: { category: true },
        })
        return reply.status(201).send({ data: asset })
      } catch {
        return reply.status(409).send({
          error: { message: 'Asset tag already in use', code: 'ALREADY_EXISTS' },
        })
      }
    },
  )

  // PATCH /:id — update asset (admin)
  fastify.patch(
    '/:id',
    { preHandler: [requireAuth, requireGlobalRole(GlobalRole.SUPER_ADMIN)] },
    async (request, reply) => {
      const { id } = request.params as { id: string }

      const result = updateAssetSchema.safeParse(request.body)
      if (!result.success) {
        return reply.status(400).send({
          error: { message: 'Validation failed', code: 'VALIDATION_ERROR', details: result.error.flatten() },
        })
      }

      try {
        const asset = await prisma.asset.update({
          where: { id },
          data: {
            ...result.data,
            purchaseDate: result.data.purchaseDate ? new Date(result.data.purchaseDate) : undefined,
            warrantyExpiry: result.data.warrantyExpiry ? new Date(result.data.warrantyExpiry) : undefined,
          },
          include: { category: true },
        })
        return reply.status(200).send({ data: asset })
      } catch {
        return reply.status(404).send({ error: { message: 'Asset not found', code: 'NOT_FOUND' } })
      }
    },
  )

  // DELETE /:id — delete asset (admin)
  fastify.delete(
    '/:id',
    { preHandler: [requireAuth, requireGlobalRole(GlobalRole.SUPER_ADMIN)] },
    async (request, reply) => {
      const { id } = request.params as { id: string }

      try {
        await prisma.asset.delete({ where: { id } })
        return reply.status(200).send({ data: { ok: true } })
      } catch {
        return reply.status(404).send({ error: { message: 'Asset not found', code: 'NOT_FOUND' } })
      }
    },
  )

  // POST /:id/assign — assign asset to user or desk
  fastify.post(
    '/:id/assign',
    { preHandler: [requireAuth, requireGlobalRole(GlobalRole.SUPER_ADMIN)] },
    async (request, reply) => {
      const { id } = request.params as { id: string }

      const result = assignSchema.safeParse(request.body)
      if (!result.success) {
        return reply.status(400).send({
          error: { message: 'Validation failed', code: 'VALIDATION_ERROR', details: result.error.flatten() },
        })
      }

      const asset = await prisma.asset.findUnique({ where: { id } })
      if (!asset) {
        return reply.status(404).send({ error: { message: 'Asset not found', code: 'NOT_FOUND' } })
      }

      if (asset.status === 'ASSIGNED') {
        return reply.status(409).send({
          error: { message: 'Asset is already assigned', code: 'CONFLICT' },
        })
      }

      const { assigneeType, assigneeId, notes } = result.data

      if (assigneeType === 'USER') {
        const user = await prisma.user.findUnique({ where: { id: assigneeId } })
        if (!user) {
          return reply.status(404).send({ error: { message: 'User not found', code: 'NOT_FOUND' } })
        }
      } else {
        const desk = await prisma.desk.findUnique({ where: { id: assigneeId } })
        if (!desk) {
          return reply.status(404).send({ error: { message: 'Desk not found', code: 'NOT_FOUND' } })
        }
      }

      const [assignment] = await prisma.$transaction([
        prisma.assetAssignment.create({
          data: {
            assetId: id,
            assigneeType,
            userId: assigneeType === 'USER' ? assigneeId : null,
            deskId: assigneeType === 'DESK' ? assigneeId : null,
            assignedById: request.user.id,
            notes: notes ?? null,
          },
          include: {
            user: { select: { id: true, displayName: true, email: true } },
            desk: { select: { id: true, name: true } },
          },
        }),
        prisma.asset.update({ where: { id }, data: { status: 'ASSIGNED' } }),
      ])

      return reply.status(201).send({ data: assignment })
    },
  )

  // POST /:id/unassign — return/unassign asset
  fastify.post(
    '/:id/unassign',
    { preHandler: [requireAuth, requireGlobalRole(GlobalRole.SUPER_ADMIN)] },
    async (request, reply) => {
      const { id } = request.params as { id: string }

      const asset = await prisma.asset.findUnique({ where: { id } })
      if (!asset) {
        return reply.status(404).send({ error: { message: 'Asset not found', code: 'NOT_FOUND' } })
      }

      const activeAssignment = await prisma.assetAssignment.findFirst({
        where: { assetId: id, returnedAt: null },
      })

      if (!activeAssignment) {
        return reply.status(409).send({
          error: { message: 'Asset is not currently assigned', code: 'CONFLICT' },
        })
      }

      const [assignment] = await prisma.$transaction([
        prisma.assetAssignment.update({
          where: { id: activeAssignment.id },
          data: { returnedAt: new Date() },
        }),
        prisma.asset.update({ where: { id }, data: { status: 'AVAILABLE' } }),
      ])

      return reply.status(200).send({ data: assignment })
    },
  )

  // GET /:id/user-assignments — list permanent user assignments
  fastify.get(
    '/:id/user-assignments',
    { preHandler: [requireAuth, requireGlobalRole(GlobalRole.SUPER_ADMIN)] },
    async (request, reply) => {
      const { id } = request.params as { id: string }
      const asset = await prisma.asset.findUnique({ where: { id } })
      if (!asset) {
        return reply.status(404).send({ error: { message: 'Asset not found', code: 'NOT_FOUND' } })
      }
      const assignments = await prisma.assetUserAssignment.findMany({
        where: { assetId: id },
        include: { user: { select: { id: true, displayName: true, email: true } } },
        orderBy: [{ isPrimary: 'desc' }, { createdAt: 'asc' }],
      })
      return reply.status(200).send({
        data: assignments.map((a) => ({ ...a.user, isPrimary: a.isPrimary })),
      })
    },
  )

  // POST /:id/user-assignments — add permanent user
  fastify.post(
    '/:id/user-assignments',
    { preHandler: [requireAuth, requireGlobalRole(GlobalRole.SUPER_ADMIN)] },
    async (request, reply) => {
      const { id } = request.params as { id: string }
      const schema = z.object({ userId: z.string().min(1), isPrimary: z.boolean().default(false) })
      const result = schema.safeParse(request.body)
      if (!result.success) {
        return reply.status(400).send({
          error: { message: 'Validation failed', code: 'VALIDATION_ERROR', details: result.error.flatten() },
        })
      }
      const asset = await prisma.asset.findUnique({ where: { id } })
      if (!asset) {
        return reply.status(404).send({ error: { message: 'Asset not found', code: 'NOT_FOUND' } })
      }
      const user = await prisma.user.findUnique({ where: { id: result.data.userId } })
      if (!user) {
        return reply.status(404).send({ error: { message: 'User not found', code: 'NOT_FOUND' } })
      }
      if (result.data.isPrimary) {
        await prisma.assetUserAssignment.updateMany({
          where: { assetId: id, isPrimary: true },
          data: { isPrimary: false },
        })
      }
      const assignment = await prisma.assetUserAssignment.upsert({
        where: { assetId_userId: { assetId: id, userId: result.data.userId } },
        update: { isPrimary: result.data.isPrimary },
        create: { assetId: id, userId: result.data.userId, isPrimary: result.data.isPrimary },
        include: { user: { select: { id: true, displayName: true, email: true } } },
      })
      return reply.status(201).send({ data: { ...assignment.user, isPrimary: assignment.isPrimary } })
    },
  )

  // DELETE /:id/user-assignments/:userId — remove permanent user
  fastify.delete(
    '/:id/user-assignments/:userId',
    { preHandler: [requireAuth, requireGlobalRole(GlobalRole.SUPER_ADMIN)] },
    async (request, reply) => {
      const { id, userId } = request.params as { id: string; userId: string }
      try {
        await prisma.assetUserAssignment.delete({
          where: { assetId_userId: { assetId: id, userId } },
        })
        return reply.status(200).send({ data: { ok: true } })
      } catch {
        return reply.status(404).send({ error: { message: 'Assignment not found', code: 'NOT_FOUND' } })
      }
    },
  )

  // PATCH /:id/user-assignments/:userId/primary — set as primary
  fastify.patch(
    '/:id/user-assignments/:userId/primary',
    { preHandler: [requireAuth, requireGlobalRole(GlobalRole.SUPER_ADMIN)] },
    async (request, reply) => {
      const { id, userId } = request.params as { id: string; userId: string }
      const existing = await prisma.assetUserAssignment.findUnique({
        where: { assetId_userId: { assetId: id, userId } },
      })
      if (!existing) {
        return reply.status(404).send({ error: { message: 'Assignment not found', code: 'NOT_FOUND' } })
      }
      await prisma.$transaction([
        prisma.assetUserAssignment.updateMany({
          where: { assetId: id, isPrimary: true },
          data: { isPrimary: false },
        }),
        prisma.assetUserAssignment.update({
          where: { assetId_userId: { assetId: id, userId } },
          data: { isPrimary: true },
        }),
      ])
      return reply.status(200).send({ data: { ok: true } })
    },
  )

  // GET /:id/history — assignment history
  fastify.get(
    '/:id/history',
    { preHandler: [requireAuth, requireGlobalRole(GlobalRole.SUPER_ADMIN)] },
    async (request, reply) => {
      const { id } = request.params as { id: string }

      const asset = await prisma.asset.findUnique({ where: { id } })
      if (!asset) {
        return reply.status(404).send({ error: { message: 'Asset not found', code: 'NOT_FOUND' } })
      }

      const history = await prisma.assetAssignment.findMany({
        where: { assetId: id },
        include: {
          user: { select: { id: true, displayName: true, email: true } },
          desk: { select: { id: true, name: true } },
        },
        orderBy: { assignedAt: 'desc' },
      })

      return reply.status(200).send({ data: history })
    },
  )
}
