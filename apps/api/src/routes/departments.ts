import type { FastifyInstance } from 'fastify'
import { prisma } from '../lib/prisma.js'
import { createDepartmentSchema, updateDepartmentSchema, GlobalRole } from '@roomer/shared'
import { requireAuth } from '../middleware/requireAuth.js'
import { requireGlobalRole } from '../middleware/requireRole.js'
import { recordAuditLog } from '../lib/audit.js'
import { z } from 'zod'

export async function departmentRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.addHook('onRoute', (route) => { route.schema = { tags: ['Departments'], ...route.schema } })

  // GET /departments — list all departments with member counts
  fastify.get('/', { preHandler: [requireAuth, requireGlobalRole(GlobalRole.SUPER_ADMIN)] }, async (_request, reply) => {
    const departments = await prisma.department.findMany({
      include: { _count: { select: { members: true } } },
      orderBy: [{ name: 'asc' }],
    })
    return reply.status(200).send({ data: departments })
  })

  // POST /departments — create department
  fastify.post('/', { preHandler: [requireAuth, requireGlobalRole(GlobalRole.SUPER_ADMIN)] }, async (request, reply) => {
    const result = createDepartmentSchema.safeParse(request.body)
    if (!result.success) {
      return reply.status(400).send({
        error: { message: 'Validation failed', code: 'VALIDATION_ERROR', details: result.error.flatten() },
      })
    }

    const org = await prisma.organisation.findFirst({ select: { id: true } })
    if (!org) return reply.status(500).send({ error: { message: 'No organisation found', code: 'NO_ORGANISATION' } })

    try {
      const department = await prisma.department.create({
        data: { organisationId: org.id, name: result.data.name },
        include: { _count: { select: { members: true } } },
      })
      await recordAuditLog(prisma, {
        actorId: request.user.id,
        action: 'department.created',
        resourceType: 'Department',
        resourceId: department.id,
        after: { name: department.name },
        ipAddress: request.ip,
      }, request.log)
      return reply.status(201).send({ data: department })
    } catch (err) {
      // Narrowed to the actual unique-constraint violation, same as PUT
      // above — a blanket catch here mislabels any other failure (a
      // transient DB error) as "already exists" instead of surfacing it as
      // the real error it is.
      if ((err as { code?: string }).code === 'P2002') {
        return reply.status(409).send({ error: { message: 'A department with this name already exists', code: 'ALREADY_EXISTS' } })
      }
      throw err
    }
  })

  // GET /departments/:id — get department with children and member count
  fastify.get('/:id', { preHandler: [requireAuth, requireGlobalRole(GlobalRole.SUPER_ADMIN)] }, async (request, reply) => {
    const { id } = request.params as { id: string }

    const department = await prisma.department.findUnique({
      where: { id },
      include: { _count: { select: { members: true } } },
    })
    if (!department) return reply.status(404).send({ error: { message: 'Department not found', code: 'NOT_FOUND' } })

    return reply.status(200).send({ data: department })
  })

  // PUT /departments/:id — rename department
  fastify.put('/:id', { preHandler: [requireAuth, requireGlobalRole(GlobalRole.SUPER_ADMIN)] }, async (request, reply) => {
    const { id } = request.params as { id: string }
    const result = updateDepartmentSchema.safeParse(request.body)
    if (!result.success) {
      return reply.status(400).send({
        error: { message: 'Validation failed', code: 'VALIDATION_ERROR', details: result.error.flatten() },
      })
    }

    try {
      const before = await prisma.department.findUnique({ where: { id }, select: { name: true } })
      const department = await prisma.department.update({
        where: { id },
        data: result.data,
        include: { _count: { select: { members: true } } },
      })
      await recordAuditLog(prisma, {
        actorId: request.user.id,
        action: 'department.updated',
        resourceType: 'Department',
        resourceId: id,
        before,
        after: { name: department.name },
        ipAddress: request.ip,
      }, request.log)
      return reply.status(200).send({ data: department })
    } catch (err) {
      // Renaming to a name that collides with another department in the org
      // hits the same @@unique([organisationId, name]) constraint POST's
      // create handler already guards against — without this check every
      // failure here (including that one) was mislabelled "not found",
      // telling the admin the department they're actively editing doesn't
      // exist instead of that the name they typed is already taken.
      if ((err as { code?: string }).code === 'P2002') {
        return reply.status(409).send({ error: { message: 'A department with this name already exists', code: 'ALREADY_EXISTS' } })
      }
      return reply.status(404).send({ error: { message: 'Department not found', code: 'NOT_FOUND' } })
    }
  })

  // DELETE /departments/:id — delete department (members get departmentId = null via SET NULL FK)
  fastify.delete('/:id', { preHandler: [requireAuth, requireGlobalRole(GlobalRole.SUPER_ADMIN)] }, async (request, reply) => {
    const { id } = request.params as { id: string }
    try {
      const deleted = await prisma.department.delete({ where: { id } })
      await recordAuditLog(prisma, {
        actorId: request.user.id,
        action: 'department.deleted',
        resourceType: 'Department',
        resourceId: id,
        before: { name: deleted.name },
        ipAddress: request.ip,
      }, request.log)
      return reply.status(200).send({ data: { ok: true } })
    } catch {
      return reply.status(404).send({ error: { message: 'Department not found', code: 'NOT_FOUND' } })
    }
  })

  // GET /departments/:id/members — list users in this department
  fastify.get('/:id/members', { preHandler: [requireAuth, requireGlobalRole(GlobalRole.SUPER_ADMIN)] }, async (request, reply) => {
    const { id } = request.params as { id: string }
    const { search } = request.query as { search?: string }

    const department = await prisma.department.findUnique({ where: { id }, select: { id: true } })
    if (!department) return reply.status(404).send({ error: { message: 'Department not found', code: 'NOT_FOUND' } })

    const users = await prisma.user.findMany({
      where: {
        departmentId: id,
        ...(search ? {
          OR: [
            { displayName: { contains: search, mode: 'insensitive' as const } },
            { email: { contains: search, mode: 'insensitive' as const } },
          ],
        } : {}),
      },
      select: { id: true, email: true, displayName: true, globalRole: true, accountStatus: true },
      orderBy: { displayName: 'asc' },
    })
    return reply.status(200).send({ data: users })
  })

  // POST /departments/:id/members — assign a user to this department
  fastify.post('/:id/members', { preHandler: [requireAuth, requireGlobalRole(GlobalRole.SUPER_ADMIN)] }, async (request, reply) => {
    const { id } = request.params as { id: string }
    const bodyResult = z.object({ userId: z.string().min(1) }).safeParse(request.body)
    if (!bodyResult.success) return reply.status(400).send({ error: { message: 'userId is required', code: 'VALIDATION_ERROR' } })

    const [department, user] = await Promise.all([
      prisma.department.findUnique({ where: { id }, select: { id: true } }),
      prisma.user.findUnique({ where: { id: bodyResult.data.userId }, select: { id: true } }),
    ])
    if (!department) return reply.status(404).send({ error: { message: 'Department not found', code: 'NOT_FOUND' } })
    if (!user) return reply.status(404).send({ error: { message: 'User not found', code: 'NOT_FOUND' } })

    await prisma.user.update({ where: { id: user.id }, data: { departmentId: id } })
    await recordAuditLog(prisma, {
      actorId: request.user.id,
      action: 'user.department_assigned',
      resourceType: 'User',
      resourceId: user.id,
      after: { departmentId: id },
      ipAddress: request.ip,
    }, request.log)
    return reply.status(200).send({ data: { ok: true } })
  })

  // DELETE /departments/:id/members/:userId — remove user from this department
  fastify.delete('/:id/members/:userId', { preHandler: [requireAuth, requireGlobalRole(GlobalRole.SUPER_ADMIN)] }, async (request, reply) => {
    const { id, userId } = request.params as { id: string; userId: string }

    const user = await prisma.user.findFirst({ where: { id: userId, departmentId: id }, select: { id: true } })
    if (!user) return reply.status(404).send({ error: { message: 'User is not a member of this department', code: 'NOT_FOUND' } })

    await prisma.user.update({ where: { id: userId }, data: { departmentId: null } })
    await recordAuditLog(prisma, {
      actorId: request.user.id,
      action: 'user.department_removed',
      resourceType: 'User',
      resourceId: userId,
      before: { departmentId: id },
      ipAddress: request.ip,
    }, request.log)
    return reply.status(200).send({ data: { ok: true } })
  })
}
