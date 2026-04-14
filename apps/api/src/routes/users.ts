import type { FastifyInstance } from 'fastify'
import bcryptjs from 'bcryptjs'
import { prisma } from '../lib/prisma'
import { GlobalRole, ResourceRoleType, ResourceScopeType } from '@roomer/shared'
import { requireAuth } from '../middleware/requireAuth'
import { requireGlobalRole } from '../middleware/requireRole'
import { enqueueNotification } from '../lib/queue'
import { NotificationType } from '@roomer/shared'
import { z } from 'zod'

const createUserSchema = z.object({
  email: z.string().email(),
  displayName: z.string().min(1).max(255),
  password: z.string().min(8),
  globalRole: z.nativeEnum(GlobalRole).optional(),
})

const updateUserSchema = z.object({
  displayName: z.string().min(1).max(255).optional(),
  accountStatus: z.enum(['ACTIVE', 'BLOCKED']).optional(),
  globalRole: z.nativeEnum(GlobalRole).optional(),
})

const assignRoleSchema = z.object({
  role: z.nativeEnum(ResourceRoleType),
  scopeType: z.nativeEnum(ResourceScopeType),
  buildingId: z.string().cuid().optional(),
  floorId: z.string().cuid().optional(),
})

const listUsersQuerySchema = z.object({
  search: z.string().optional(),
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(100).default(20),
})

export async function userRoutes(fastify: FastifyInstance): Promise<void> {
  // POST /users — create user (admin)
  fastify.post(
    '/',
    { preHandler: [requireAuth, requireGlobalRole(GlobalRole.SUPER_ADMIN)] },
    async (request, reply) => {
      const result = createUserSchema.safeParse(request.body)
      if (!result.success) {
        return reply.status(400).send({
          error: { message: 'Validation failed', code: 'VALIDATION_ERROR', details: result.error.flatten() },
        })
      }

      const { email, displayName, password, globalRole } = result.data

      const existing = await prisma.user.findUnique({ where: { email } })
      if (existing) {
        return reply.status(409).send({
          error: { message: 'A user with this email already exists', code: 'ALREADY_EXISTS' },
        })
      }

      const org = await prisma.organisation.findFirst()
      if (!org) {
        return reply.status(500).send({
          error: { message: 'No organisation found', code: 'INTERNAL_ERROR' },
        })
      }

      const passwordHash = await bcryptjs.hash(password, 12)
      const user = await prisma.user.create({
        data: {
          email,
          displayName,
          passwordHash,
          globalRole: globalRole ?? GlobalRole.USER,
        },
        select: {
          id: true, email: true, displayName: true,
          provider: true, accountStatus: true, globalRole: true,
          createdAt: true, updatedAt: true,
        },
      })

      // Send welcome email (non-blocking)
      enqueueNotification({ type: NotificationType.WELCOME, userId: user.id }).catch((err) =>
        fastify.log.warn({ err }, 'Failed to enqueue welcome notification'),
      )

      return reply.status(201).send({ data: user })
    },
  )

  // GET /users — list users (admin), paginated, filterable
  fastify.get(
    '/',
    { preHandler: [requireAuth, requireGlobalRole(GlobalRole.SUPER_ADMIN)] },
    async (request, reply) => {
      const result = listUsersQuerySchema.safeParse(request.query)
      if (!result.success) {
        return reply.status(400).send({
          error: { message: 'Invalid query parameters', code: 'VALIDATION_ERROR' },
        })
      }

      const { search, page, limit } = result.data
      const skip = (page - 1) * limit

      const where = search
        ? {
            OR: [
              { email: { contains: search, mode: 'insensitive' as const } },
              { displayName: { contains: search, mode: 'insensitive' as const } },
            ],
          }
        : {}

      const [users, total] = await Promise.all([
        prisma.user.findMany({
          where,
          skip,
          take: limit,
          select: {
            id: true,
            email: true,
            displayName: true,
            provider: true,
            accountStatus: true,
            globalRole: true,
            createdAt: true,
            updatedAt: true,
            _count: { select: { bookings: true } },
          },
          orderBy: { displayName: 'asc' },
        }),
        prisma.user.count({ where }),
      ])

      return reply.status(200).send({
        data: users,
        meta: { page, limit, total, totalPages: Math.ceil(total / limit) },
      })
    },
  )

  // GET /users/:id — get user
  fastify.get('/:id', { preHandler: [requireAuth] }, async (request, reply) => {
    const { id } = request.params as { id: string }

    const isSelf = request.user.id === id
    const isAdmin = request.user.globalRole === 'SUPER_ADMIN'

    if (!isSelf && !isAdmin) {
      return reply.status(403).send({ error: { message: 'Forbidden', code: 'FORBIDDEN' } })
    }

    const user = await prisma.user.findUnique({
      where: { id },
      select: {
        id: true,
        email: true,
        displayName: true,
        provider: true,
        accountStatus: true,
        globalRole: true,
        createdAt: true,
        updatedAt: true,
        resourceRoles: {
          include: {
            building: { select: { id: true, name: true } },
            floor: { select: { id: true, name: true } },
          },
        },
      },
    })

    if (!user) {
      return reply.status(404).send({ error: { message: 'User not found', code: 'NOT_FOUND' } })
    }

    return reply.status(200).send({ data: user })
  })

  // PATCH /users/:id — update user
  fastify.patch('/:id', { preHandler: [requireAuth] }, async (request, reply) => {
    const { id } = request.params as { id: string }

    const isSelf = request.user.id === id
    const isAdmin = request.user.globalRole === 'SUPER_ADMIN'

    if (!isSelf && !isAdmin) {
      return reply.status(403).send({ error: { message: 'Forbidden', code: 'FORBIDDEN' } })
    }

    const result = updateUserSchema.safeParse(request.body)
    if (!result.success) {
      return reply.status(400).send({
        error: { message: 'Validation failed', code: 'VALIDATION_ERROR', details: result.error.flatten() },
      })
    }

    // Only admins can change accountStatus or globalRole
    if ((result.data.accountStatus || result.data.globalRole) && !isAdmin) {
      return reply.status(403).send({
        error: { message: 'Only admins can change account status or role', code: 'FORBIDDEN' },
      })
    }

    try {
      const updated = await prisma.user.update({
        where: { id },
        data: result.data,
        select: {
          id: true,
          email: true,
          displayName: true,
          provider: true,
          accountStatus: true,
          globalRole: true,
          createdAt: true,
          updatedAt: true,
        },
      })
      return reply.status(200).send({ data: updated })
    } catch {
      return reply.status(404).send({ error: { message: 'User not found', code: 'NOT_FOUND' } })
    }
  })

  // GET /users/:id/bookings — get user's bookings
  fastify.get('/:id/bookings', { preHandler: [requireAuth] }, async (request, reply) => {
    const { id } = request.params as { id: string }

    const isSelf = request.user.id === id
    const isAdmin = request.user.globalRole === 'SUPER_ADMIN'

    if (!isSelf && !isAdmin) {
      return reply.status(403).send({ error: { message: 'Forbidden', code: 'FORBIDDEN' } })
    }

    const bookings = await prisma.booking.findMany({
      where: { userId: id },
      include: {
        asset: {
          include: {
            floor: { include: { building: { select: { id: true, name: true } } } },
            primaryZone: { select: { id: true, name: true } },
          },
        },
      },
      orderBy: { startsAt: 'desc' },
    })

    return reply.status(200).send({ data: bookings })
  })

  // POST /users/:id/resource-roles — assign resource role (admin)
  fastify.post(
    '/:id/resource-roles',
    { preHandler: [requireAuth, requireGlobalRole(GlobalRole.SUPER_ADMIN)] },
    async (request, reply) => {
      const { id } = request.params as { id: string }

      const result = assignRoleSchema.safeParse(request.body)
      if (!result.success) {
        return reply.status(400).send({
          error: { message: 'Validation failed', code: 'VALIDATION_ERROR', details: result.error.flatten() },
        })
      }

      const user = await prisma.user.findUnique({ where: { id } })
      if (!user) {
        return reply.status(404).send({ error: { message: 'User not found', code: 'NOT_FOUND' } })
      }

      if (result.data.scopeType === 'BUILDING' && !result.data.buildingId) {
        return reply.status(400).send({
          error: { message: 'buildingId is required for BUILDING scope', code: 'VALIDATION_ERROR' },
        })
      }

      if (result.data.scopeType === 'FLOOR' && !result.data.floorId) {
        return reply.status(400).send({
          error: { message: 'floorId is required for FLOOR scope', code: 'VALIDATION_ERROR' },
        })
      }

      try {
        const role = await prisma.userResourceRole.create({
          data: {
            userId: id,
            role: result.data.role,
            scopeType: result.data.scopeType,
            buildingId: result.data.buildingId ?? null,
            floorId: result.data.floorId ?? null,
          },
        })
        return reply.status(201).send({ data: role })
      } catch {
        return reply.status(409).send({
          error: { message: 'Role already assigned', code: 'ALREADY_EXISTS' },
        })
      }
    },
  )

  // DELETE /users/:id/resource-roles/:roleId — remove resource role (admin)
  fastify.delete(
    '/:id/resource-roles/:roleId',
    { preHandler: [requireAuth, requireGlobalRole(GlobalRole.SUPER_ADMIN)] },
    async (request, reply) => {
      const { id, roleId } = request.params as { id: string; roleId: string }

      try {
        await prisma.userResourceRole.delete({
          where: { id: roleId, userId: id },
        })
        return reply.status(200).send({ data: { ok: true } })
      } catch {
        return reply.status(404).send({ error: { message: 'Role not found', code: 'NOT_FOUND' } })
      }
    },
  )
}
