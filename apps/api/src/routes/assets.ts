import type { FastifyInstance } from 'fastify'
import { prisma } from '../lib/prisma'
import { GlobalRole, BookableStatus, bulkUpdateAssetPositionsSchema } from '@roomer/shared'
import { requireAuth } from '../middleware/requireAuth'
import { requireGlobalRole, getManagedFloorIds, isFloorManagerForFloor } from '../middleware/requireRole'
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
  serialNumber: z.string().optional().transform((v) => v === '' ? undefined : v),
  assetTag: z.string().optional().transform((v) => v === '' ? undefined : v),
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
  serialNumber: z.string().optional().transform((v) => v === '' ? undefined : v),
  assetTag: z.string().optional().transform((v) => v === '' ? undefined : v),
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

const bulkImportRowSchema = z.object({
  name: z.string().min(1).max(255),
  categoryName: z.string().min(1).max(255),
  bookingStatus: z.nativeEnum(BookableStatus).optional().default(BookableStatus.OPEN),
  bookingLabel: z.string().max(255).optional().default('Desk'),
  amenities: z.array(z.string()).optional().default([]),
  serialNumber: z.string().optional(),
  assetTag: z.string().optional(),
  notes: z.string().optional(),
  zoneName: z.string().optional(),
})

const bulkImportSchema = z.object({
  floorId: z.string().min(1),
  assets: z.array(bulkImportRowSchema).min(1).max(500),
})

export async function assetRoutes(fastify: FastifyInstance): Promise<void> {
  // POST /bulk-import — create multiple bookable assets and place them on a floor
  fastify.post(
    '/bulk-import',
    { preHandler: [requireAuth, requireGlobalRole(GlobalRole.SUPER_ADMIN)] },
    async (request, reply) => {
      const result = bulkImportSchema.safeParse(request.body)
      if (!result.success) {
        return reply.status(400).send({
          error: { message: 'Validation failed', code: 'VALIDATION_ERROR', details: result.error.flatten() },
        })
      }

      const { floorId, assets } = result.data

      const floor = await prisma.floor.findUnique({
        where: { id: floorId },
        include: { zones: true },
      })
      if (!floor) {
        return reply.status(404).send({ error: { message: 'Floor not found', code: 'NOT_FOUND' } })
      }

      const created: { id: string; name: string }[] = []
      const errors: { row: number; name: string; error: string }[] = []

      for (const [index, row] of assets.entries()) {
        try {
          // Look up or create category by name
          let category = await prisma.assetCategory.findFirst({ where: { name: row.categoryName } })
          if (!category) {
            category = await prisma.assetCategory.create({
              data: { name: row.categoryName, defaultIsBookable: true, defaultIcon: 'monitor' },
            })
          }

          // Resolve zone: match by name on this floor, fall back to first zone
          let primaryZoneId: string | undefined
          if (row.zoneName) {
            const zone = floor.zones.find((z) => z.name.toLowerCase() === row.zoneName!.toLowerCase())
            if (zone) primaryZoneId = zone.id
          }
          if (!primaryZoneId && floor.zones.length > 0) {
            primaryZoneId = floor.zones[0].id
          }

          const asset = await prisma.asset.create({
            data: {
              categoryId: category.id,
              name: row.name,
              isBookable: true,
              bookingLabel: row.bookingLabel ?? 'Desk',
              bookingStatus: row.bookingStatus ?? BookableStatus.OPEN,
              amenities: row.amenities ?? [],
              serialNumber: row.serialNumber ?? null,
              assetTag: row.assetTag ?? null,
              notes: row.notes ?? null,
              floorId,
              primaryZoneId: primaryZoneId ?? null,
              x: 50,
              y: 50,
              width: 3,
              height: 2,
            },
          })
          created.push({ id: asset.id, name: asset.name })
        } catch (err) {
          errors.push({
            row: index + 1,
            name: row.name,
            error: err instanceof Error ? err.message : 'Unknown error',
          })
        }
      }

      return reply.status(200).send({ data: { created: created.length, errors } })
    },
  )

  // PATCH /positions — bulk update positions (must be before /:id)
  // Accessible to SUPER_ADMIN and FLOOR_MANAGERs (restricted to their managed floors).
  fastify.patch(
    '/positions',
    { preHandler: [requireAuth] },
    async (request, reply) => {
      const result = bulkUpdateAssetPositionsSchema.safeParse(request.body)
      if (!result.success) {
        return reply.status(400).send({
          error: { message: 'Validation failed', code: 'VALIDATION_ERROR', details: result.error.flatten() },
        })
      }

      const isAdmin = request.user.globalRole === GlobalRole.SUPER_ADMIN
      if (!isAdmin) {
        const managedFloorIds = await getManagedFloorIds(request.user.id)
        if (managedFloorIds.length === 0) {
          return reply.status(403).send({ error: { message: 'Insufficient permissions', code: 'FORBIDDEN' } })
        }
        const assetIds = result.data.assets.map((a) => a.id)
        const assets = await prisma.asset.findMany({
          where: { id: { in: assetIds } },
          select: { id: true, floorId: true },
        })
        const unauthorized = assets.filter((a) => !a.floorId || !managedFloorIds.includes(a.floorId))
        if (unauthorized.length > 0) {
          return reply.status(403).send({ error: { message: 'One or more assets are not on your managed floors', code: 'FORBIDDEN' } })
        }
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

    // Floor manager: return assets on all managed floors
    const managedFloorIds = await getManagedFloorIds(request.user.id)
    if (managedFloorIds.length > 0) {
      const assets = await prisma.asset.findMany({
        where: { floorId: { in: managedFloorIds } },
        include: {
          category: true,
          assignments: {
            where: { returnedAt: null },
            include: { user: { select: { id: true, displayName: true, email: true } } },
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

    // Regular user: return only personally assigned assets
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

  // GET /my-assignments — assets permanently assigned to the current user
  fastify.get('/my-assignments', { preHandler: [requireAuth] }, async (request, reply) => {
    const userId = request.user.id
    const now = new Date()

    const assignments = await prisma.assetUserAssignment.findMany({
      where: { userId },
      include: {
        asset: {
          include: {
            category: { select: { id: true, name: true } },
            floor: {
              select: {
                id: true, name: true,
                building: { select: { id: true, name: true } },
              },
            },
            primaryZone: { select: { id: true, name: true } },
            availabilityWindows: {
              where: { ownerId: userId, endsAt: { gt: now } },
              orderBy: { startsAt: 'asc' },
            },
          },
        },
      },
    })

    return reply.status(200).send({ data: assignments })
  })

  // POST /assets/:id/availability-windows — create an availability window
  fastify.post('/:id/availability-windows', { preHandler: [requireAuth] }, async (request, reply) => {
    const { id } = request.params as { id: string }
    const body = request.body as { startsAt?: string; endsAt?: string; note?: string }

    if (!body.startsAt || !body.endsAt) {
      return reply.status(400).send({ error: { message: 'startsAt and endsAt are required', code: 'VALIDATION_ERROR' } })
    }

    const startsAt = new Date(body.startsAt)
    const endsAt = new Date(body.endsAt)

    if (isNaN(startsAt.getTime()) || isNaN(endsAt.getTime()) || endsAt <= startsAt) {
      return reply.status(400).send({ error: { message: 'Invalid time range', code: 'VALIDATION_ERROR' } })
    }

    // Only the permanently assigned user (or SUPER_ADMIN) may create a window
    const assignment = await prisma.assetUserAssignment.findUnique({
      where: { assetId_userId: { assetId: id, userId: request.user.id } },
    })
    if (!assignment && request.user.globalRole !== 'SUPER_ADMIN') {
      return reply.status(403).send({ error: { message: 'You are not permanently assigned to this asset', code: 'FORBIDDEN' } })
    }

    const asset = await prisma.asset.findUnique({ where: { id }, select: { id: true } })
    if (!asset) {
      return reply.status(404).send({ error: { message: 'Asset not found', code: 'NOT_FOUND' } })
    }

    const window = await prisma.assetAvailabilityWindow.create({
      data: { assetId: id, ownerId: request.user.id, startsAt, endsAt, note: body.note ?? null },
    })
    return reply.status(201).send({ data: window })
  })

  // GET /assets/:id/availability-windows — list active windows
  fastify.get('/:id/availability-windows', { preHandler: [requireAuth] }, async (request, reply) => {
    const { id } = request.params as { id: string }
    const now = new Date()

    const windows = await prisma.assetAvailabilityWindow.findMany({
      where: { assetId: id, endsAt: { gt: now } },
      orderBy: { startsAt: 'asc' },
      include: { owner: { select: { id: true, displayName: true } } },
    })
    return reply.status(200).send({ data: windows })
  })

  // DELETE /assets/:id/availability-windows/:windowId — remove a window
  fastify.delete('/:id/availability-windows/:windowId', { preHandler: [requireAuth] }, async (request, reply) => {
    const { id, windowId } = request.params as { id: string; windowId: string }

    const window = await prisma.assetAvailabilityWindow.findUnique({ where: { id: windowId } })
    if (!window || window.assetId !== id) {
      return reply.status(404).send({ error: { message: 'Availability window not found', code: 'NOT_FOUND' } })
    }
    if (window.ownerId !== request.user.id && request.user.globalRole !== 'SUPER_ADMIN') {
      return reply.status(403).send({ error: { message: 'Insufficient permissions', code: 'FORBIDDEN' } })
    }

    await prisma.assetAvailabilityWindow.delete({ where: { id: windowId } })
    return reply.status(200).send({ data: { ok: true } })
  })

  // DELETE /user-assignments/by-floor/:floorId — clear all permanent assignments on a floor
  fastify.delete(
    '/user-assignments/by-floor/:floorId',
    { preHandler: [requireAuth, requireGlobalRole(GlobalRole.SUPER_ADMIN)] },
    async (request, reply) => {
      const { floorId } = request.params as { floorId: string }
      const floor = await prisma.floor.findUnique({ where: { id: floorId } })
      if (!floor) {
        return reply.status(404).send({ error: { message: 'Floor not found', code: 'NOT_FOUND' } })
      }
      const assets = await prisma.asset.findMany({ where: { floorId }, select: { id: true } })
      const assetIds = assets.map((a) => a.id)
      if (assetIds.length === 0) {
        return reply.status(200).send({ data: { cleared: 0 } })
      }
      const { count } = await prisma.assetUserAssignment.deleteMany({ where: { assetId: { in: assetIds } } })
      if (count > 0) {
        await prisma.asset.updateMany({
          where: { id: { in: assetIds }, bookingStatus: 'ASSIGNED' },
          data: { bookingStatus: 'OPEN' },
        })
      }
      return reply.status(200).send({ data: { cleared: count } })
    },
  )

  // POST /user-assignments/bulk — bulk create/update permanent user assignments
  fastify.post(
    '/user-assignments/bulk',
    { preHandler: [requireAuth, requireGlobalRole(GlobalRole.SUPER_ADMIN)] },
    async (request, reply) => {
      const bodySchema = z.object({
        rows: z.array(z.object({
          assetId: z.string().min(1),
          userEmail: z.string().email(),
          isPrimary: z.boolean().optional().default(false),
        })).min(1).max(5000),
      })
      const parsed = bodySchema.safeParse(request.body)
      if (!parsed.success) {
        return reply.status(400).send({
          error: { message: 'Validation failed', code: 'VALIDATION_ERROR', details: parsed.error.flatten() },
        })
      }
      const { rows } = parsed.data
      let assigned = 0
      const errors: Array<{ row: number; assetId: string; userEmail: string; error: string }> = []

      for (let i = 0; i < rows.length; i++) {
        const { assetId, userEmail, isPrimary } = rows[i]
        try {
          const [asset, user] = await Promise.all([
            prisma.asset.findUnique({ where: { id: assetId }, select: { id: true } }),
            prisma.user.findUnique({ where: { email: userEmail }, select: { id: true } }),
          ])
          if (!asset) { errors.push({ row: i + 1, assetId, userEmail, error: 'Asset not found' }); continue }
          if (!user) { errors.push({ row: i + 1, assetId, userEmail, error: 'User not found' }); continue }
          if (isPrimary) {
            await prisma.assetUserAssignment.updateMany({
              where: { assetId, isPrimary: true },
              data: { isPrimary: false },
            })
          }
          await prisma.assetUserAssignment.upsert({
            where: { assetId_userId: { assetId, userId: user.id } },
            update: { isPrimary },
            create: { assetId, userId: user.id, isPrimary },
          })
          await prisma.asset.update({ where: { id: assetId }, data: { bookingStatus: 'ASSIGNED' } })
          assigned++
        } catch {
          errors.push({ row: i + 1, assetId, userEmail, error: 'Unexpected error' })
        }
      }

      return reply.status(200).send({ data: { assigned, errors } })
    },
  )

  // GET /user-assignments/export — export asset+assignment data for CSV generation
  fastify.get(
    '/user-assignments/export',
    { preHandler: [requireAuth, requireGlobalRole(GlobalRole.SUPER_ADMIN)] },
    async (request, reply) => {
      const { buildingId } = request.query as { buildingId?: string }
      const whereClause = buildingId ? { floor: { building: { id: buildingId } } } : {}
      const assets = await prisma.asset.findMany({
        where: whereClause,
        select: {
          id: true,
          name: true,
          userAssignments: {
            include: { user: { select: { email: true } } },
          },
        },
        orderBy: { name: 'asc' },
      })
      const rows = assets.flatMap((a) =>
        a.userAssignments.length > 0
          ? a.userAssignments.map((ua) => ({
              assetId: a.id,
              assetName: a.name,
              userEmail: ua.user.email,
              isPrimary: ua.isPrimary,
            }))
          : [{ assetId: a.id, assetName: a.name, userEmail: '', isPrimary: false }],
      )
      return reply.status(200).send({ data: rows })
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
      const hasPersonalAccess = asset.assignments.some(
        (a) => a.userId === request.user.id && a.returnedAt === null,
      )
      const hasFloorAccess = !!asset.floorId && await isFloorManagerForFloor(request.user.id, asset.floorId)
      if (!hasPersonalAccess && !hasFloorAccess) {
        return reply.status(404).send({ error: { message: 'Asset not found', code: 'NOT_FOUND' } })
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
      } catch (err) {
        if ((err as { code?: string }).code === 'P2025') {
          return reply.status(404).send({ error: { message: 'Asset not found', code: 'NOT_FOUND' } })
        }
        fastify.log.error(err, 'Failed to update asset')
        return reply.status(500).send({ error: { message: 'Internal server error', code: 'INTERNAL_ERROR' } })
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
        // Status is stuck as ASSIGNED with no active record — reset it
        if (asset.status === 'ASSIGNED') {
          await prisma.asset.update({ where: { id }, data: { status: 'AVAILABLE' } })
          return reply.status(200).send({ data: { ok: true } })
        }
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
      await prisma.asset.update({ where: { id }, data: { bookingStatus: 'ASSIGNED' } })
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
        const remaining = await prisma.assetUserAssignment.count({ where: { assetId: id } })
        if (remaining === 0) {
          await prisma.asset.update({ where: { id }, data: { bookingStatus: 'OPEN' } })
        }
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
