import type { FastifyInstance } from 'fastify'
import { prisma } from '../lib/prisma'
import {
  createDeskSchema,
  updateDeskSchema,
  bulkUpdatePositionsSchema,
  GlobalRole,
  ResourceRoleType,
} from '@roomer/shared'
import { requireAuth } from '../middleware/requireAuth'
import { requireGlobalRole, requireFloorRoleForDesk } from '../middleware/requireRole'
import { z } from 'zod'

const addToAllowListSchema = z.object({
  userId: z.string().min(1, 'Invalid user ID'),
})

const addUserAssignmentSchema = z.object({
  userId: z.string().min(1, 'Invalid user ID'),
  isPrimary: z.boolean().optional().default(false),
})

const addZoneSchema = z.object({
  zoneId: z.string().min(1, 'Invalid zone ID'),
})

export async function deskRoutes(fastify: FastifyInstance): Promise<void> {
  // POST /desks — create desk
  fastify.post(
    '/',
    { preHandler: [requireAuth, requireGlobalRole(GlobalRole.SUPER_ADMIN)] },
    async (request, reply) => {
      const result = createDeskSchema.safeParse(request.body)
      if (!result.success) {
        return reply.status(400).send({
          error: { message: 'Validation failed', code: 'VALIDATION_ERROR', details: result.error.flatten() },
        })
      }

      const zone = await prisma.zone.findUnique({ where: { id: result.data.zoneId } })
      if (!zone) {
        return reply.status(404).send({ error: { message: 'Zone not found', code: 'NOT_FOUND' } })
      }

      const desk = await prisma.desk.create({
        data: {
          zoneId: result.data.zoneId,
          name: result.data.name,
          x: result.data.x,
          y: result.data.y,
          width: result.data.width ?? 3.0,
          height: result.data.height ?? 2.0,
          rotation: result.data.rotation ?? 0,
          status: result.data.status ?? 'OPEN',
          amenities: result.data.amenities ?? [],
        },
      })

      return reply.status(201).send({ data: desk })
    },
  )

  // PUT /desks/:id — update desk (SUPER_ADMIN or floor manager)
  fastify.put(
    '/:id',
    { preHandler: [requireAuth, requireFloorRoleForDesk(ResourceRoleType.FLOOR_MANAGER)] },
    async (request, reply) => {
      const { id } = request.params as { id: string }
      const result = updateDeskSchema.safeParse(request.body)
      if (!result.success) {
        return reply.status(400).send({
          error: { message: 'Validation failed', code: 'VALIDATION_ERROR', details: result.error.flatten() },
        })
      }

      try {
        const desk = await prisma.desk.update({ where: { id }, data: result.data })
        return reply.status(200).send({ data: desk })
      } catch {
        return reply.status(404).send({ error: { message: 'Desk not found', code: 'NOT_FOUND' } })
      }
    },
  )

  // DELETE /desks/:id
  fastify.delete(
    '/:id',
    { preHandler: [requireAuth, requireGlobalRole(GlobalRole.SUPER_ADMIN)] },
    async (request, reply) => {
      const { id } = request.params as { id: string }
      try {
        await prisma.desk.delete({ where: { id } })
        return reply.status(200).send({ data: { ok: true } })
      } catch {
        return reply.status(404).send({ error: { message: 'Desk not found', code: 'NOT_FOUND' } })
      }
    },
  )

  // GET /desks/:id/bookings?from=ISO&to=ISO
  fastify.get('/:id/bookings', { preHandler: [requireAuth] }, async (request, reply) => {
    const { id } = request.params as { id: string }
    const { from, to } = request.query as { from?: string; to?: string }

    const desk = await prisma.desk.findUnique({ where: { id } })
    if (!desk) {
      return reply.status(404).send({ error: { message: 'Desk not found', code: 'NOT_FOUND' } })
    }

    const where: Record<string, unknown> = { deskId: id }
    if (from || to) {
      where['startsAt'] = {}
      where['endsAt'] = {}
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

  // GET /desks/:id/assignments — list permanent user assignments (SUPER_ADMIN or floor manager)
  fastify.get(
    '/:id/assignments',
    { preHandler: [requireAuth, requireFloorRoleForDesk(ResourceRoleType.FLOOR_MANAGER)] },
    async (request, reply) => {
      const { id } = request.params as { id: string }
      const desk = await prisma.desk.findUnique({ where: { id } })
      if (!desk) return reply.status(404).send({ error: { message: 'Desk not found', code: 'NOT_FOUND' } })

      const assignments = await prisma.deskUserAssignment.findMany({
        where: { deskId: id },
        include: { user: { select: { id: true, displayName: true, email: true } } },
        orderBy: [{ isPrimary: 'desc' }, { createdAt: 'asc' }],
      })

      return reply.status(200).send({ data: assignments.map((a) => ({ ...a.user, isPrimary: a.isPrimary })) })
    },
  )

  // POST /desks/:id/assignments — add a permanent user assignment (SUPER_ADMIN or floor manager)
  fastify.post(
    '/:id/assignments',
    { preHandler: [requireAuth, requireFloorRoleForDesk(ResourceRoleType.FLOOR_MANAGER)] },
    async (request, reply) => {
      const { id } = request.params as { id: string }
      const result = addUserAssignmentSchema.safeParse(request.body)
      if (!result.success) {
        return reply.status(400).send({
          error: { message: 'Validation failed', code: 'VALIDATION_ERROR', details: result.error.flatten() },
        })
      }

      const [desk, user] = await Promise.all([
        prisma.desk.findUnique({ where: { id } }),
        prisma.user.findUnique({ where: { id: result.data.userId } }),
      ])
      if (!desk) return reply.status(404).send({ error: { message: 'Desk not found', code: 'NOT_FOUND' } })
      if (!user) return reply.status(404).send({ error: { message: 'User not found', code: 'NOT_FOUND' } })

      await prisma.$transaction(async (tx) => {
        // If setting as primary, demote existing primary
        if (result.data.isPrimary) {
          await tx.deskUserAssignment.updateMany({ where: { deskId: id, isPrimary: true }, data: { isPrimary: false } })
        }
        await tx.deskUserAssignment.upsert({
          where: { deskId_userId: { deskId: id, userId: result.data.userId } },
          create: { deskId: id, userId: result.data.userId, isPrimary: result.data.isPrimary },
          update: { isPrimary: result.data.isPrimary },
        })
        await tx.desk.update({ where: { id }, data: { status: 'ASSIGNED' } })
      })

      const assignments = await prisma.deskUserAssignment.findMany({
        where: { deskId: id },
        include: { user: { select: { id: true, displayName: true, email: true } } },
        orderBy: [{ isPrimary: 'desc' }, { createdAt: 'asc' }],
      })

      return reply.status(201).send({ data: assignments.map((a) => ({ ...a.user, isPrimary: a.isPrimary })) })
    },
  )

  // DELETE /desks/:id/assignments/:userId — remove a permanent user assignment (SUPER_ADMIN or floor manager)
  fastify.delete(
    '/:id/assignments/:userId',
    { preHandler: [requireAuth, requireFloorRoleForDesk(ResourceRoleType.FLOOR_MANAGER)] },
    async (request, reply) => {
      const { id, userId } = request.params as { id: string; userId: string }

      try {
        await prisma.deskUserAssignment.delete({ where: { deskId_userId: { deskId: id, userId } } })
      } catch {
        return reply.status(404).send({ error: { message: 'Assignment not found', code: 'NOT_FOUND' } })
      }

      // If no assignments remain, reset desk status to OPEN
      const remaining = await prisma.deskUserAssignment.count({ where: { deskId: id } })
      if (remaining === 0) {
        await prisma.desk.update({ where: { id }, data: { status: 'OPEN' } })
      }

      return reply.status(200).send({ data: { ok: true } })
    },
  )

  // PATCH /desks/:id/assignments/:userId/primary — promote to primary (SUPER_ADMIN or floor manager)
  fastify.patch(
    '/:id/assignments/:userId/primary',
    { preHandler: [requireAuth, requireFloorRoleForDesk(ResourceRoleType.FLOOR_MANAGER)] },
    async (request, reply) => {
      const { id, userId } = request.params as { id: string; userId: string }

      const existing = await prisma.deskUserAssignment.findUnique({
        where: { deskId_userId: { deskId: id, userId } },
      })
      if (!existing) return reply.status(404).send({ error: { message: 'Assignment not found', code: 'NOT_FOUND' } })

      await prisma.$transaction([
        prisma.deskUserAssignment.updateMany({ where: { deskId: id, isPrimary: true }, data: { isPrimary: false } }),
        prisma.deskUserAssignment.update({ where: { deskId_userId: { deskId: id, userId } }, data: { isPrimary: true } }),
      ])

      const assignments = await prisma.deskUserAssignment.findMany({
        where: { deskId: id },
        include: { user: { select: { id: true, displayName: true, email: true } } },
        orderBy: [{ isPrimary: 'desc' }, { createdAt: 'asc' }],
      })

      return reply.status(200).send({ data: assignments.map((a) => ({ ...a.user, isPrimary: a.isPrimary })) })
    },
  )

  // GET /desks/:id/zones — list additional zone memberships
  fastify.get(
    '/:id/zones',
    { preHandler: [requireAuth, requireGlobalRole(GlobalRole.SUPER_ADMIN)] },
    async (request, reply) => {
      const { id } = request.params as { id: string }
      const deskZones = await prisma.deskZone.findMany({
        where: { deskId: id },
        include: { zone: { select: { id: true, name: true, colour: true } } },
        orderBy: { createdAt: 'asc' },
      })
      return reply.status(200).send({ data: deskZones.map((dz) => dz.zone) })
    },
  )

  // POST /desks/:id/zones — add desk to an additional zone
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

      const [desk, zone] = await Promise.all([
        prisma.desk.findUnique({ where: { id } }),
        prisma.zone.findUnique({ where: { id: result.data.zoneId } }),
      ])
      if (!desk) return reply.status(404).send({ error: { message: 'Desk not found', code: 'NOT_FOUND' } })
      if (!zone) return reply.status(404).send({ error: { message: 'Zone not found', code: 'NOT_FOUND' } })

      // Prevent adding the primary zone as an additional zone
      if (desk.zoneId === result.data.zoneId) {
        return reply.status(409).send({ error: { message: 'Zone is already the primary zone', code: 'CONFLICT' } })
      }

      try {
        await prisma.deskZone.create({ data: { deskId: id, zoneId: result.data.zoneId } })
      } catch {
        return reply.status(409).send({ error: { message: 'Desk already in this zone', code: 'ALREADY_EXISTS' } })
      }

      const deskZones = await prisma.deskZone.findMany({
        where: { deskId: id },
        include: { zone: { select: { id: true, name: true, colour: true } } },
        orderBy: { createdAt: 'asc' },
      })
      return reply.status(201).send({ data: deskZones.map((dz) => dz.zone) })
    },
  )

  // DELETE /desks/:id/zones/:zoneId — remove desk from additional zone
  fastify.delete(
    '/:id/zones/:zoneId',
    { preHandler: [requireAuth, requireGlobalRole(GlobalRole.SUPER_ADMIN)] },
    async (request, reply) => {
      const { id, zoneId } = request.params as { id: string; zoneId: string }

      try {
        await prisma.deskZone.delete({ where: { deskId_zoneId: { deskId: id, zoneId } } })
      } catch {
        return reply.status(404).send({ error: { message: 'Zone membership not found', code: 'NOT_FOUND' } })
      }

      return reply.status(200).send({ data: { ok: true } })
    },
  )

  // POST /desks/:id/allow-list — add userId to allow list
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

      const desk = await prisma.desk.findUnique({ where: { id } })
      if (!desk) {
        return reply.status(404).send({ error: { message: 'Desk not found', code: 'NOT_FOUND' } })
      }

      const user = await prisma.user.findUnique({ where: { id: result.data.userId } })
      if (!user) {
        return reply.status(404).send({ error: { message: 'User not found', code: 'NOT_FOUND' } })
      }

      try {
        const entry = await prisma.deskAllowList.create({
          data: { deskId: id, userId: result.data.userId },
        })
        return reply.status(201).send({ data: entry })
      } catch {
        return reply.status(409).send({
          error: { message: 'User already on allow list', code: 'ALREADY_EXISTS' },
        })
      }
    },
  )

  // DELETE /desks/:id/allow-list/:userId
  fastify.delete(
    '/:id/allow-list/:userId',
    { preHandler: [requireAuth, requireGlobalRole(GlobalRole.SUPER_ADMIN)] },
    async (request, reply) => {
      const { id, userId } = request.params as { id: string; userId: string }

      try {
        await prisma.deskAllowList.delete({
          where: { deskId_userId: { deskId: id, userId } },
        })
        return reply.status(200).send({ data: { ok: true } })
      } catch {
        return reply.status(404).send({
          error: { message: 'Allow list entry not found', code: 'NOT_FOUND' },
        })
      }
    },
  )

  // GET /desks/:id/allow-list — list allow-list entries (admin)
  fastify.get(
    '/:id/allow-list',
    { preHandler: [requireAuth, requireGlobalRole(GlobalRole.SUPER_ADMIN)] },
    async (request, reply) => {
      const { id } = request.params as { id: string }

      const desk = await prisma.desk.findUnique({ where: { id } })
      if (!desk) {
        return reply.status(404).send({ error: { message: 'Desk not found', code: 'NOT_FOUND' } })
      }

      const entries = await prisma.deskAllowList.findMany({
        where: { deskId: id },
        include: { user: { select: { id: true, displayName: true, email: true } } },
        orderBy: { createdAt: 'asc' },
      })

      return reply.status(200).send({ data: entries.map((e) => e.user) })
    },
  )

  // PATCH /desks/positions — bulk update positions for drag-and-drop
  fastify.patch(
    '/positions',
    { preHandler: [requireAuth, requireGlobalRole(GlobalRole.SUPER_ADMIN)] },
    async (request, reply) => {
      const result = bulkUpdatePositionsSchema.safeParse(request.body)
      if (!result.success) {
        return reply.status(400).send({
          error: { message: 'Validation failed', code: 'VALIDATION_ERROR', details: result.error.flatten() },
        })
      }

      const updates = await prisma.$transaction(
        result.data.desks.map((d) =>
          prisma.desk.update({
            where: { id: d.id },
            data: {
              x: d.x,
              y: d.y,
              ...(d.width !== undefined && { width: d.width }),
              ...(d.height !== undefined && { height: d.height }),
              ...(d.rotation !== undefined && { rotation: d.rotation }),
            },
          }),
        ),
      )

      return reply.status(200).send({ data: updates })
    },
  )
}
