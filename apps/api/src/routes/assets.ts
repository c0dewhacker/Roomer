import type { FastifyInstance } from 'fastify'
import { prisma } from '../lib/prisma'
import { GlobalRole, BookableStatus, bulkUpdateAssetPositionsSchema } from '@roomer/shared'
import { requireAuth } from '../middleware/requireAuth'
import { requireGlobalRole } from '../middleware/requireRole'
import { z } from 'zod'

const createCategorySchema = z.object({
  name: z.string().min(1).max(255),
  description: z.string().optional(),
  defaultIsBookable: z.boolean().optional(),
  defaultIcon: z.string().max(255).optional(),
  colour: z.string().regex(/^#[0-9a-fA-F]{6}$/, 'colour must be a 6-digit hex colour').default('#6366f1'),
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
  // Bookable-asset fields
  isBookable: z.boolean().optional(),
  bookingLabel: z.string().max(255).optional(),
  amenities: z.array(z.string()).optional(),
  bookingStatus: z.nativeEnum(BookableStatus).optional(),
  primaryZoneId: z.string().optional(),
  floorId: z.string().optional(),
  x: z.number().optional(),
  y: z.number().optional(),
  width: z.number().positive().optional(),
  height: z.number().positive().optional(),
  rotation: z.number().min(-360).max(360).optional(),
})

const updateAssetSchema = z.object({
  categoryId: z.string().min(1).optional(),
  name: z.string().min(1).max(255).optional(),
  description: z.string().optional(),
  serialNumber: z.string().optional(),
  assetTag: z.string().optional(),
  status: z.enum(['AVAILABLE', 'ASSIGNED', 'MAINTENANCE', 'RETIRED', 'DISABLED']).optional(),
  purchaseDate: z.string().datetime().optional(),
  warrantyExpiry: z.string().datetime().optional(),
  notes: z.string().optional(),
  // Bookable-asset fields
  isBookable: z.boolean().optional(),
  bookingLabel: z.string().max(255).nullable().optional(),
  amenities: z.array(z.string()).optional(),
  bookingStatus: z.nativeEnum(BookableStatus).optional(),
  primaryZoneId: z.string().nullable().optional(),
  floorId: z.string().nullable().optional(),
  x: z.number().nullable().optional(),
  y: z.number().nullable().optional(),
  width: z.number().positive().nullable().optional(),
  height: z.number().positive().nullable().optional(),
  rotation: z.number().min(-360).max(360).nullable().optional(),
})

const assignSchema = z.object({
  userId: z.string().min(1),
  notes: z.string().optional(),
})

const addToAllowListSchema = z.object({
  userId: z.string().min(1, 'Invalid user ID'),
})

const addZoneSchema = z.object({
  zoneId: z.string().min(1, 'Invalid zone ID'),
})

export async function assetRoutes(fastify: FastifyInstance): Promise<void> {
  // PATCH /positions — bulk update positions (must be before /:id)
  fastify.patch(
    '/positions',
    { preHandler: [requireAuth, requireGlobalRole(GlobalRole.SUPER_ADMIN)] },
    async (request, reply) => {
      const result = bulkUpdateAssetPositionsSchema.safeParse(request.body)
      if (!result.success) {
        return reply.status(400).send({
          error: { message: 'Validation failed', code: 'VALIDATION_ERROR', details: result.error.flatten() },
        })
      }

      const updates = await prisma.$transaction(
        result.data.assets.map((a) =>
          prisma.asset.update({
            where: { id: a.id },
            data: {
              x: a.x,
              y: a.y,
              ...(a.width !== undefined && { width: a.width }),
              ...(a.height !== undefined && { height: a.height }),
              ...(a.rotation !== undefined && { rotation: a.rotation }),
            },
          }),
        ),
      )

      return reply.status(200).send({ data: updates })
    },
  )

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
            },
          },
          userAssignments: {
            include: { user: { select: { id: true, displayName: true, email: true } } },
          },
          allowList: {
            include: { user: { select: { id: true, displayName: true, email: true } } },
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
          },
          orderBy: { assignedAt: 'desc' },
        },
        userAssignments: {
          include: { user: { select: { id: true, displayName: true, email: true } } },
        },
        allowList: {
          include: { user: { select: { id: true, displayName: true, email: true } } },
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
        const { primaryZoneId, floorId, purchaseDate: purchaseDateStr, warrantyExpiry: warrantyExpiryStr, ...rest } = result.data
        const asset = await prisma.asset.create({
          data: {
            ...rest,
            purchaseDate: purchaseDateStr ? new Date(purchaseDateStr) : undefined,
            warrantyExpiry: warrantyExpiryStr ? new Date(warrantyExpiryStr) : undefined,
            ...(primaryZoneId ? { primaryZoneId } : {}),
            ...(floorId ? { floorId } : {}),
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

  // PATCH /:id — update asset (super admin, or floor manager for assets on their floor)
  fastify.patch(
    '/:id',
    { preHandler: [requireAuth] },
    async (request, reply) => {
      const { id } = request.params as { id: string }

      const result = updateAssetSchema.safeParse(request.body)
      if (!result.success) {
        return reply.status(400).send({
          error: { message: 'Validation failed', code: 'VALIDATION_ERROR', details: result.error.flatten() },
        })
      }

      // Authorization: super admin can edit any asset; floor managers can edit assets on their floor
      const isAdmin = request.user.globalRole === 'SUPER_ADMIN'
      if (!isAdmin) {
        const existing = await prisma.asset.findUnique({ where: { id }, select: { floorId: true } })
        if (!existing) {
          return reply.status(404).send({ error: { message: 'Asset not found', code: 'NOT_FOUND' } })
        }
        if (!existing.floorId) {
          return reply.status(403).send({ error: { message: 'Forbidden', code: 'FORBIDDEN' } })
        }
        const directRole = await prisma.userResourceRole.findFirst({
          where: { userId: request.user.id, scopeType: 'FLOOR', floorId: existing.floorId, role: 'FLOOR_MANAGER' },
        })
        const groupRole = !directRole
          ? await prisma.groupResourceRole.findFirst({
              where: {
                scopeType: 'FLOOR',
                floorId: existing.floorId,
                role: 'FLOOR_MANAGER',
                group: { members: { some: { userId: request.user.id } } },
              },
            })
          : null
        if (!directRole && !groupRole) {
          return reply.status(403).send({ error: { message: 'Forbidden', code: 'FORBIDDEN' } })
        }
      }

      try {
        const { purchaseDate: purchaseDateStr, warrantyExpiry: warrantyExpiryStr, ...rest } = result.data
        const asset = await prisma.asset.update({
          where: { id },
          data: {
            ...rest,
            purchaseDate: purchaseDateStr !== undefined ? (purchaseDateStr ? new Date(purchaseDateStr) : null) : undefined,
            warrantyExpiry: warrantyExpiryStr !== undefined ? (warrantyExpiryStr ? new Date(warrantyExpiryStr) : null) : undefined,
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

  // POST /:id/assign — assign asset to user
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

      const { userId, notes } = result.data
      const user = await prisma.user.findUnique({ where: { id: userId } })
      if (!user) {
        return reply.status(404).send({ error: { message: 'User not found', code: 'NOT_FOUND' } })
      }

      const [assignment] = await prisma.$transaction([
        prisma.assetAssignment.create({
          data: {
            assetId: id,
            userId,
            assignedById: request.user.id,
            notes: notes ?? null,
          },
          include: {
            user: { select: { id: true, displayName: true, email: true } },
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
        },
        orderBy: { assignedAt: 'desc' },
      })

      return reply.status(200).send({ data: history })
    },
  )

  // POST /:id/allow-list — add userId to allow list (bookable assets)
  fastify.post(
    '/:id/allow-list',
    { preHandler: [requireAuth, requireGlobalRole(GlobalRole.SUPER_ADMIN)] },
    async (request, reply) => {
      const { id } = request.params as { id: string }
      const result = addToAllowListSchema.safeParse(request.body)
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

      try {
        const entry = await prisma.assetAllowList.create({
          data: { assetId: id, userId: result.data.userId },
        })
        return reply.status(201).send({ data: entry })
      } catch {
        return reply.status(409).send({
          error: { message: 'User already on allow list', code: 'ALREADY_EXISTS' },
        })
      }
    },
  )

  // DELETE /:id/allow-list/:userId
  fastify.delete(
    '/:id/allow-list/:userId',
    { preHandler: [requireAuth, requireGlobalRole(GlobalRole.SUPER_ADMIN)] },
    async (request, reply) => {
      const { id, userId } = request.params as { id: string; userId: string }

      try {
        await prisma.assetAllowList.delete({
          where: { assetId_userId: { assetId: id, userId } },
        })
        return reply.status(200).send({ data: { ok: true } })
      } catch {
        return reply.status(404).send({
          error: { message: 'Allow list entry not found', code: 'NOT_FOUND' },
        })
      }
    },
  )

  // GET /:id/allow-list — list allow-list entries
  fastify.get(
    '/:id/allow-list',
    { preHandler: [requireAuth, requireGlobalRole(GlobalRole.SUPER_ADMIN)] },
    async (request, reply) => {
      const { id } = request.params as { id: string }

      const asset = await prisma.asset.findUnique({ where: { id } })
      if (!asset) {
        return reply.status(404).send({ error: { message: 'Asset not found', code: 'NOT_FOUND' } })
      }

      const entries = await prisma.assetAllowList.findMany({
        where: { assetId: id },
        include: { user: { select: { id: true, displayName: true, email: true } } },
        orderBy: { createdAt: 'asc' },
      })

      return reply.status(200).send({ data: entries.map((e) => e.user) })
    },
  )

  // GET /:id/zones — list additional zone memberships
  fastify.get(
    '/:id/zones',
    { preHandler: [requireAuth, requireGlobalRole(GlobalRole.SUPER_ADMIN)] },
    async (request, reply) => {
      const { id } = request.params as { id: string }
      const assetZones = await prisma.assetZone.findMany({
        where: { assetId: id },
        include: { zone: { select: { id: true, name: true, colour: true } } },
        orderBy: { createdAt: 'asc' },
      })
      return reply.status(200).send({ data: assetZones.map((az) => az.zone) })
    },
  )

  // POST /:id/zones — add asset to an additional zone
  fastify.post(
    '/:id/zones',
    { preHandler: [requireAuth, requireGlobalRole(GlobalRole.SUPER_ADMIN)] },
    async (request, reply) => {
      const { id } = request.params as { id: string }
      const result = addZoneSchema.safeParse(request.body)
      if (!result.success) {
        return reply.status(400).send({
          error: { message: 'Validation failed', code: 'VALIDATION_ERROR', details: result.error.flatten() },
        })
      }

      const [asset, zone] = await Promise.all([
        prisma.asset.findUnique({ where: { id } }),
        prisma.zone.findUnique({ where: { id: result.data.zoneId } }),
      ])
      if (!asset) return reply.status(404).send({ error: { message: 'Asset not found', code: 'NOT_FOUND' } })
      if (!zone) return reply.status(404).send({ error: { message: 'Zone not found', code: 'NOT_FOUND' } })

      // Prevent adding the primary zone as an additional zone
      if (asset.primaryZoneId === result.data.zoneId) {
        return reply.status(409).send({ error: { message: 'Zone is already the primary zone', code: 'CONFLICT' } })
      }

      try {
        await prisma.assetZone.create({ data: { assetId: id, zoneId: result.data.zoneId } })
      } catch {
        return reply.status(409).send({ error: { message: 'Asset already in this zone', code: 'ALREADY_EXISTS' } })
      }

      const assetZones = await prisma.assetZone.findMany({
        where: { assetId: id },
        include: { zone: { select: { id: true, name: true, colour: true } } },
        orderBy: { createdAt: 'asc' },
      })
      return reply.status(201).send({ data: assetZones.map((az) => az.zone) })
    },
  )

  // DELETE /:id/zones/:zoneId — remove asset from additional zone
  fastify.delete(
    '/:id/zones/:zoneId',
    { preHandler: [requireAuth, requireGlobalRole(GlobalRole.SUPER_ADMIN)] },
    async (request, reply) => {
      const { id, zoneId } = request.params as { id: string; zoneId: string }

      try {
        await prisma.assetZone.delete({ where: { assetId_zoneId: { assetId: id, zoneId } } })
      } catch {
        return reply.status(404).send({ error: { message: 'Zone membership not found', code: 'NOT_FOUND' } })
      }

      return reply.status(200).send({ data: { ok: true } })
    },
  )

  // GET /:id/bookings?from=ISO&to=ISO — bookings for this asset
  fastify.get('/:id/bookings', { preHandler: [requireAuth] }, async (request, reply) => {
    const { id } = request.params as { id: string }
    const { from, to } = request.query as { from?: string; to?: string }

    const asset = await prisma.asset.findUnique({ where: { id } })
    if (!asset) {
      return reply.status(404).send({ error: { message: 'Asset not found', code: 'NOT_FOUND' } })
    }

    const where: Record<string, unknown> = { assetId: id }
    if (from || to) {
      where['endsAt'] = {}
      where['startsAt'] = {}
      if (from) (where['endsAt'] as Record<string, unknown>)['gt'] = new Date(from)
      if (to) (where['startsAt'] as Record<string, unknown>)['lt'] = new Date(to)
    }

    const bookings = await prisma.booking.findMany({
      where,
      include: { user: { select: { id: true, displayName: true, email: true } } },
      orderBy: { startsAt: 'asc' },
    })

    return reply.status(200).send({ data: bookings })
  })
}
