import type { FastifyInstance } from 'fastify'
import bcryptjs from 'bcryptjs'
import crypto from 'crypto'
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

const userImportRowSchema = z.object({
  email: z.string().email('Invalid email'),
  display_name: z.string().min(1, 'display_name is required').max(255),
  password: z.string().optional(),
  global_role: z.enum(['USER', 'SUPER_ADMIN']).default('USER'),
  access_groups: z.string().optional(),
  send_welcome_email: z.string().optional().transform((v) => v !== 'false' && v !== '0'),
})

const userImportBodySchema = z.object({
  rows: z.array(z.record(z.string())).min(1).max(1000),
})

export async function userRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.addHook('onRoute', (route) => { route.schema = { tags: ['Users'], ...route.schema } })

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
        groupMemberships: {
          include: { group: { select: { id: true, name: true, globalRole: true } } },
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

  // POST /users/bulk-import — CSV user import with optional group assignments (SUPER_ADMIN)
  // Body: { rows: Array<{ email, display_name, password?, global_role?, access_groups?, send_welcome_email? }> }
  // access_groups: semicolon-separated group names (looked up by name, case-insensitive)
  fastify.post(
    '/bulk-import',
    { preHandler: [requireAuth, requireGlobalRole(GlobalRole.SUPER_ADMIN)] },
    async (request, reply) => {
      const body = userImportBodySchema.safeParse(request.body)
      if (!body.success) {
        return reply.status(400).send({ error: { message: 'Invalid request body', code: 'VALIDATION_ERROR' } })
      }

      const org = await prisma.organisation.findFirst({ select: { id: true } })
      if (!org) return reply.status(500).send({ error: { message: 'No organisation found', code: 'INTERNAL_ERROR' } })

      let created = 0
      let updated = 0
      const errors: Array<{ row: number; message: string }> = []

      // Validate all rows first
      type ValidRow = z.infer<typeof userImportRowSchema>
      const validRows: Array<{ index: number; row: ValidRow }> = []
      for (let i = 0; i < body.data.rows.length; i++) {
        const result = userImportRowSchema.safeParse(body.data.rows[i])
        if (!result.success) {
          errors.push({ row: i + 2, message: result.error.issues.map((e) => e.message).join('; ') })
        } else {
          validRows.push({ index: i, row: result.data })
        }
      }

      if (validRows.length === 0) {
        return reply.status(422).send({ error: { message: 'No valid rows', code: 'NO_VALID_ROWS' }, data: { errors } })
      }

      // Pre-resolve group names → IDs (case-insensitive)
      const allGroupNames = new Set<string>()
      for (const { row } of validRows) {
        if (row.access_groups) {
          row.access_groups.split(';').map((g) => g.trim()).filter(Boolean).forEach((g) => allGroupNames.add(g.toLowerCase()))
        }
      }
      const groupsByName = new Map<string, string>() // lowercase name → id
      if (allGroupNames.size > 0) {
        const groups = await prisma.userGroup.findMany({
          where: { organisationId: org.id },
          select: { id: true, name: true },
        })
        for (const g of groups) groupsByName.set(g.name.toLowerCase(), g.id)
      }

      for (const { index, row } of validRows) {
        try {
          const existing = await prisma.user.findUnique({ where: { email: row.email } })
          let userId: string

          if (existing) {
            await prisma.user.update({
              where: { email: row.email },
              data: { displayName: row.display_name, globalRole: row.global_role as GlobalRole },
            })
            userId = existing.id
            updated++
          } else {
            const password = row.password?.trim() || crypto.randomBytes(12).toString('base64url')
            const passwordHash = await bcryptjs.hash(password, 12)
            const user = await prisma.user.create({
              data: { email: row.email, displayName: row.display_name, passwordHash, globalRole: row.global_role as GlobalRole },
              select: { id: true },
            })
            userId = user.id
            created++
            if (row.send_welcome_email) {
              enqueueNotification({ type: NotificationType.WELCOME, userId }).catch(() => {})
            }
          }

          // Assign to access groups
          if (row.access_groups) {
            const names = row.access_groups.split(';').map((g) => g.trim()).filter(Boolean)
            for (const name of names) {
              const groupId = groupsByName.get(name.toLowerCase())
              if (!groupId) { errors.push({ row: index + 2, message: `Group "${name}" not found` }); continue }
              await prisma.userGroupMember.upsert({
                where: { groupId_userId: { groupId, userId } },
                create: { groupId, userId },
                update: {},
              })
            }
          }
        } catch (err) {
          errors.push({ row: index + 2, message: err instanceof Error ? err.message : 'Unknown error' })
        }
      }

      return reply.status(200).send({ data: { created, updated, errors } })
    },
  )
}
