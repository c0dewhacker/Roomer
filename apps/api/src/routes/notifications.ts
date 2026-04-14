import type { FastifyInstance } from 'fastify'
import { prisma } from '../lib/prisma'
import { requireAuth } from '../middleware/requireAuth'
import { z } from 'zod'

const paginationSchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(100).default(20),
})

export async function notificationRoutes(fastify: FastifyInstance): Promise<void> {
  // GET /notifications/unread-count — must be before /:id to avoid route conflict
  fastify.get('/unread-count', { preHandler: [requireAuth] }, async (request, reply) => {
    const count = await prisma.notification.count({
      where: { userId: request.user.id, read: false },
    })
    return reply.status(200).send({ data: { count } })
  })

  // GET /notifications — current user's notifications, newest first, paginated
  fastify.get('/', { preHandler: [requireAuth] }, async (request, reply) => {
    const result = paginationSchema.safeParse(request.query)
    if (!result.success) {
      return reply.status(400).send({
        error: { message: 'Invalid query parameters', code: 'VALIDATION_ERROR' },
      })
    }

    const { page, limit } = result.data
    const skip = (page - 1) * limit

    const [notifications, total] = await Promise.all([
      prisma.notification.findMany({
        where: { userId: request.user.id },
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' },
      }),
      prisma.notification.count({ where: { userId: request.user.id } }),
    ])

    return reply.status(200).send({
      data: notifications,
      meta: { page, limit, total, totalPages: Math.ceil(total / limit) },
    })
  })

  // PATCH /notifications/read-all — mark all as read
  fastify.patch('/read-all', { preHandler: [requireAuth] }, async (request, reply) => {
    await prisma.notification.updateMany({
      where: { userId: request.user.id, read: false },
      data: { read: true },
    })
    return reply.status(200).send({ data: { ok: true } })
  })

  // PATCH /notifications/:id/read — mark single as read
  fastify.patch('/:id/read', { preHandler: [requireAuth] }, async (request, reply) => {
    const { id } = request.params as { id: string }

    const notification = await prisma.notification.findUnique({ where: { id } })
    if (!notification) {
      return reply.status(404).send({ error: { message: 'Notification not found', code: 'NOT_FOUND' } })
    }

    if (notification.userId !== request.user.id) {
      return reply.status(403).send({ error: { message: 'Forbidden', code: 'FORBIDDEN' } })
    }

    const updated = await prisma.notification.update({
      where: { id },
      data: { read: true },
    })

    return reply.status(200).send({ data: updated })
  })
}
