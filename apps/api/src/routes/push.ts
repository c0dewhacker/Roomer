import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { prisma } from '../lib/prisma.js'
import { requireAuth } from '../middleware/requireAuth.js'
import { getVapidPublicKey } from '../lib/push.js'

const subscribeSchema = z.object({
  endpoint: z.string().url(),
  keys: z.object({
    p256dh: z.string().min(1),
    auth: z.string().min(1),
  }),
})

const unsubscribeSchema = z.object({
  endpoint: z.string().url(),
})

export async function pushRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.addHook('onRoute', (route) => { route.schema = { tags: ['Push'], ...route.schema } })

  // GET /push/vapid-public-key — public: the frontend needs this before a user
  // is necessarily logged in to know whether to even offer the push toggle.
  fastify.get('/vapid-public-key', async (_request, reply) => {
    return reply.status(200).send({ data: { publicKey: getVapidPublicKey() } })
  })

  // POST /push/subscribe — upsert by endpoint, since re-subscribing the same
  // browser (e.g. after the user cleared site permissions) yields a fresh
  // endpoint/keys triple for what's conceptually the same device.
  fastify.post('/subscribe', { preHandler: [requireAuth] }, async (request, reply) => {
    const result = subscribeSchema.safeParse(request.body)
    if (!result.success) {
      return reply.status(400).send({
        error: { message: 'Validation failed', code: 'VALIDATION_ERROR', details: result.error.flatten() },
      })
    }
    const { endpoint, keys } = result.data
    const userAgent = request.headers['user-agent']?.slice(0, 255)

    await prisma.pushSubscription.upsert({
      where: { endpoint },
      // A subscription's endpoint can be re-registered by a different user on
      // a shared device (e.g. a kiosk) — update ties it to whoever just
      // subscribed rather than leaving it pointed at the previous owner.
      update: { userId: request.user.id, p256dh: keys.p256dh, auth: keys.auth, userAgent },
      create: { userId: request.user.id, endpoint, p256dh: keys.p256dh, auth: keys.auth, userAgent },
    })

    return reply.status(200).send({ data: { ok: true } })
  })

  // POST /push/unsubscribe — idempotent: unsubscribing a browser that was
  // never subscribed (or already pruned as dead) is not an error.
  fastify.post('/unsubscribe', { preHandler: [requireAuth] }, async (request, reply) => {
    const result = unsubscribeSchema.safeParse(request.body)
    if (!result.success) {
      return reply.status(400).send({
        error: { message: 'Validation failed', code: 'VALIDATION_ERROR', details: result.error.flatten() },
      })
    }

    // Scoped to the caller's own userId so one user can't unsubscribe another's device.
    await prisma.pushSubscription.deleteMany({ where: { endpoint: result.data.endpoint, userId: request.user.id } })
    return reply.status(200).send({ data: { ok: true } })
  })
}
