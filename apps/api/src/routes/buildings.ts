import type { FastifyInstance } from 'fastify'
import { prisma } from '../lib/prisma'
import { createBuildingSchema, updateBuildingSchema } from '@roomer/shared'
import { requireAuth } from '../middleware/requireAuth'
import { requireGlobalRole } from '../middleware/requireRole'
import { GlobalRole } from '@roomer/shared'

export async function buildingRoutes(fastify: FastifyInstance): Promise<void> {
  // GET /buildings — list all buildings with floor count
  fastify.get('/', { preHandler: [requireAuth] }, async (_request, reply) => {
    const buildings = await prisma.building.findMany({
      include: {
        organisation: { select: { id: true, name: true, slug: true } },
        _count: { select: { floors: true } },
      },
      orderBy: { name: 'asc' },
    })

    return reply.status(200).send({ data: buildings })
  })

  // POST /buildings — create building (SUPER_ADMIN only)
  fastify.post(
    '/',
    { preHandler: [requireAuth, requireGlobalRole(GlobalRole.SUPER_ADMIN)] },
    async (request, reply) => {
      const result = createBuildingSchema.safeParse(request.body)
      if (!result.success) {
        return reply.status(400).send({
          error: { message: 'Validation failed', code: 'VALIDATION_ERROR', details: result.error.flatten() },
        })
      }

      // Use the first organisation (single-tenant v1)
      const org = await prisma.organisation.findFirst()
      if (!org) {
        return reply.status(500).send({
          error: { message: 'No organisation found', code: 'NO_ORGANISATION' },
        })
      }

      const building = await prisma.building.create({
        data: {
          organisationId: org.id,
          name: result.data.name,
          address: result.data.address ?? null,
        },
        include: { _count: { select: { floors: true } } },
      })

      return reply.status(201).send({ data: building })
    },
  )

  // GET /buildings/:id — get building with floors
  fastify.get('/:id', { preHandler: [requireAuth] }, async (request, reply) => {
    const { id } = request.params as { id: string }

    const building = await prisma.building.findUnique({
      where: { id },
      include: {
        organisation: { select: { id: true, name: true, slug: true } },
        floors: {
          orderBy: { level: 'asc' },
          include: {
            _count: { select: { zones: true } },
          },
        },
        _count: { select: { floors: true } },
      },
    })

    if (!building) {
      return reply.status(404).send({
        error: { message: 'Building not found', code: 'NOT_FOUND' },
      })
    }

    return reply.status(200).send({ data: building })
  })

  // PUT /buildings/:id — update building (SUPER_ADMIN)
  fastify.put(
    '/:id',
    { preHandler: [requireAuth, requireGlobalRole(GlobalRole.SUPER_ADMIN)] },
    async (request, reply) => {
      const { id } = request.params as { id: string }
      const result = updateBuildingSchema.safeParse(request.body)
      if (!result.success) {
        return reply.status(400).send({
          error: { message: 'Validation failed', code: 'VALIDATION_ERROR', details: result.error.flatten() },
        })
      }

      try {
        const building = await prisma.building.update({
          where: { id },
          data: result.data,
        })
        return reply.status(200).send({ data: building })
      } catch {
        return reply.status(404).send({
          error: { message: 'Building not found', code: 'NOT_FOUND' },
        })
      }
    },
  )

  // DELETE /buildings/:id (SUPER_ADMIN)
  fastify.delete(
    '/:id',
    { preHandler: [requireAuth, requireGlobalRole(GlobalRole.SUPER_ADMIN)] },
    async (request, reply) => {
      const { id } = request.params as { id: string }

      try {
        await prisma.building.delete({ where: { id } })
        return reply.status(200).send({ data: { ok: true } })
      } catch {
        return reply.status(404).send({
          error: { message: 'Building not found', code: 'NOT_FOUND' },
        })
      }
    },
  )
}
