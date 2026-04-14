import type { FastifyInstance } from 'fastify'
import { prisma } from '../lib/prisma'
import { createZoneSchema, updateZoneSchema, createZoneGroupSchema, GlobalRole } from '@roomer/shared'
import { requireAuth } from '../middleware/requireAuth'
import { requireGlobalRole } from '../middleware/requireRole'

export async function zoneRoutes(fastify: FastifyInstance): Promise<void> {
  // POST /zones — create zone
  fastify.post(
    '/',
    { preHandler: [requireAuth, requireGlobalRole(GlobalRole.SUPER_ADMIN)] },
    async (request, reply) => {
      const result = createZoneSchema.safeParse(request.body)
      if (!result.success) {
        return reply.status(400).send({
          error: { message: 'Validation failed', code: 'VALIDATION_ERROR', details: result.error.flatten() },
        })
      }

      const floor = await prisma.floor.findUnique({ where: { id: result.data.floorId } })
      if (!floor) {
        return reply.status(404).send({ error: { message: 'Floor not found', code: 'NOT_FOUND' } })
      }

      if (result.data.zoneGroupId) {
        const group = await prisma.zoneGroup.findUnique({ where: { id: result.data.zoneGroupId } })
        if (!group || group.floorId !== result.data.floorId) {
          return reply.status(404).send({
            error: { message: 'Zone group not found on this floor', code: 'NOT_FOUND' },
          })
        }
      }

      const zone = await prisma.zone.create({
        data: {
          floorId: result.data.floorId,
          name: result.data.name,
          colour: result.data.colour ?? '#6366f1',
          zoneGroupId: result.data.zoneGroupId ?? null,
        },
      })

      return reply.status(201).send({ data: zone })
    },
  )

  // PUT /zones/:id — update zone
  fastify.put(
    '/:id',
    { preHandler: [requireAuth, requireGlobalRole(GlobalRole.SUPER_ADMIN)] },
    async (request, reply) => {
      const { id } = request.params as { id: string }
      const result = updateZoneSchema.safeParse(request.body)
      if (!result.success) {
        return reply.status(400).send({
          error: { message: 'Validation failed', code: 'VALIDATION_ERROR', details: result.error.flatten() },
        })
      }

      try {
        const zone = await prisma.zone.update({
          where: { id },
          data: result.data,
        })
        return reply.status(200).send({ data: zone })
      } catch {
        return reply.status(404).send({ error: { message: 'Zone not found', code: 'NOT_FOUND' } })
      }
    },
  )

  // DELETE /zones/:id
  fastify.delete(
    '/:id',
    { preHandler: [requireAuth, requireGlobalRole(GlobalRole.SUPER_ADMIN)] },
    async (request, reply) => {
      const { id } = request.params as { id: string }
      try {
        await prisma.zone.delete({ where: { id } })
        return reply.status(200).send({ data: { ok: true } })
      } catch {
        return reply.status(404).send({ error: { message: 'Zone not found', code: 'NOT_FOUND' } })
      }
    },
  )
}

export async function zoneGroupRoutes(fastify: FastifyInstance): Promise<void> {
  // POST /zone-groups — create zone group
  fastify.post(
    '/',
    { preHandler: [requireAuth, requireGlobalRole(GlobalRole.SUPER_ADMIN)] },
    async (request, reply) => {
      const result = createZoneGroupSchema.safeParse(request.body)
      if (!result.success) {
        return reply.status(400).send({
          error: { message: 'Validation failed', code: 'VALIDATION_ERROR', details: result.error.flatten() },
        })
      }

      const floor = await prisma.floor.findUnique({ where: { id: result.data.floorId } })
      if (!floor) {
        return reply.status(404).send({ error: { message: 'Floor not found', code: 'NOT_FOUND' } })
      }

      const group = await prisma.zoneGroup.create({
        data: {
          floorId: result.data.floorId,
          name: result.data.name,
        },
      })

      return reply.status(201).send({ data: group })
    },
  )

  // DELETE /zone-groups/:id
  fastify.delete(
    '/:id',
    { preHandler: [requireAuth, requireGlobalRole(GlobalRole.SUPER_ADMIN)] },
    async (request, reply) => {
      const { id } = request.params as { id: string }
      try {
        await prisma.zoneGroup.delete({ where: { id } })
        return reply.status(200).send({ data: { ok: true } })
      } catch {
        return reply.status(404).send({ error: { message: 'Zone group not found', code: 'NOT_FOUND' } })
      }
    },
  )
}
